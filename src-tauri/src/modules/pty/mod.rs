//! Terminal session backend: the PTY/SSH multiplexer the frontend drives.
//!
//! [`PtyState`] holds every live session: a `HashMap<u32, Arc<Session>>` keyed
//! by physical id, a `logical_id -> physical_id` map for the reopen/replace
//! path, and a monotonic `next_id` (starts at 1; ids are never reused). The
//! [`Session`] enum (`Local` portable-pty | `Ssh` russh) lets `pty_write` /
//! `pty_resize` / `pty_close` dispatch on the variant, so the SSH path
//! (`ssh_open` inserting a `Session::Ssh`) reuses the same commands.
//!
//! Output flows to xterm.js as [`PtyEvent`] over a Tauri `Channel`: a reader
//! thread fills a pending buffer, a flusher thread base64-encodes and sends it
//! every 16 ms, and a waiter thread emits `Exit` last. A bounded reader queue
//! applies kernel PTY backpressure instead of deleting terminal protocol bytes;
//! each frontend event is capped at 128 KiB. Local sessions inject shell integration via
//! [`shell_init`] (OSC 7/133 markers, agent-hook socket env).
//!
//! Commands: [`pty_open`], [`pty_write`], [`pty_resize`], [`pty_close`].
pub(crate) mod output_flow;
mod session;
mod shell_init;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;

use tauri::ipc::Channel;

pub use session::PtyEvent;
pub use session::Session;

use super::agent::hooks::HookListenerState;
use super::agent::wrapper;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    logical_sessions: RwLock<HashMap<String, u32>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            logical_sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl PtyState {
    pub fn close_all(&self) {
        let sessions: Vec<(u32, Arc<Session>)> = self.sessions.write().drain().collect();
        self.logical_sessions.write().clear();
        for (id, session) in sessions {
            if let Err(e) = session.kill() {
                log::debug!("pty close_all: kill id={id} returned {e}");
            }
            log::info!("pty closed id={id}");
        }
    }

    /// Remove (and kill) any session bound to a logical id. Used by both
    /// pty_open and ssh_open on the reopen/replace path.
    pub fn remove_logical(&self, logical_id: &str) {
        let old_id = self.logical_sessions.write().remove(logical_id);
        if let Some(old_id) = old_id {
            let old_session = self.sessions.write().remove(&old_id);
            if let Some(session) = old_session {
                if let Err(e) = session.kill() {
                    log::debug!("remove_logical: kill id={old_id} returned {e}");
                }
                log::info!("session replaced id={old_id} logical_session_id={logical_id}");
            }
        }
    }

    /// Look up a live session by physical id (used by the SFTP commands to
    /// reach the SSH connection behind a session).
    pub fn get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.read().get(&id).cloned()
    }

    /// Resolve the physical PTY currently owned by a logical frontend session.
    /// Preview evidence uses this to avoid writing to whichever terminal happens
    /// to be selected when the user presses Send.
    pub fn physical_for_logical(&self, logical_id: &str) -> Option<u32> {
        self.logical_sessions.read().get(logical_id).copied()
    }

    /// Register an already-built session under a fresh id, optionally bound to a
    /// logical id, replacing (and killing) any session already bound to that
    /// logical id. Returns the physical id. Used by both pty_open and ssh_open.
    ///
    /// Both maps are locked together for the whole replace so it is atomic with
    /// respect to a concurrent open of the SAME logical id. Tauri dispatches
    /// sync commands on a worker pool, so two `pty_open`s carrying one logical
    /// id can run on different threads; doing the id bump and the two map
    /// inserts as separate lock acquisitions let them interleave so both insert
    /// distinct physical ids and the loser's session is orphaned — reachable by
    /// neither the logical id nor (from the backend) its physical id — and leaks
    /// alive until close_all. Evicting the prior binding inside one critical
    /// section turns that orphan into a clean kill+remove.
    ///
    /// Lock order is sessions-then-logical, matching close_all; no other method
    /// holds both simultaneously, so this cannot deadlock.
    pub fn insert(&self, session: Arc<Session>, logical_id: Option<&str>) -> u32 {
        let mut sessions = self.sessions.write();
        let mut logical = self.logical_sessions.write();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Some(lid) = logical_id {
            if let Some(old_id) = logical.insert(lid.to_string(), id) {
                if let Some(old) = sessions.remove(&old_id) {
                    if let Err(e) = old.kill() {
                        log::debug!("insert: kill replaced id={old_id} returned {e}");
                    }
                    log::info!("session replaced id={old_id} logical_session_id={lid}");
                }
            }
        }
        sessions.insert(id, session);
        id
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_open(
    app: tauri::AppHandle,
    state: tauri::State<PtyState>,
    preview_state: tauri::State<crate::modules::preview::PreviewWindowState>,
    hooks_state: tauri::State<HookListenerState>,
    logical_session_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    if let Some(logical_id) = logical_session_id.as_deref() {
        if let Some(old_id) = state.physical_for_logical(logical_id) {
            preview_state.close_tunnels_for_pty(&app, old_id);
        }
        state.remove_logical(logical_id);
        wrapper::cleanup_hooks_settings(logical_id, hooks_state.agent_config_dir());
    }

    let sock = hooks_state.sock_path();
    let (session, _) = session::spawn(
        cols,
        rows,
        cwd,
        on_event,
        logical_session_id.as_deref(),
        if sock.is_empty() { None } else { Some(sock) },
    )
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    // Atomic replace: same critical section binds the id and evicts any prior
    // session for this logical id, so two racing same-logical-id opens can't
    // orphan a session (see PtyState::insert).
    let id = state.insert(session, logical_session_id.as_deref());
    if let Some(logical_id) = logical_session_id {
        log::info!("pty opened id={id} logical_session_id={logical_id} cols={cols} rows={rows}");
    } else {
        log::info!("pty opened id={id} cols={cols} rows={rows}");
    }
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state.sessions.read().get(&id).cloned().ok_or_else(|| {
        log::warn!("pty_write: unknown id={id}");
        "no session".to_string()
    })?;
    session.write(data.as_bytes()).map_err(|e| {
        // EPIPE / closed channel is expected if the remote already exited.
        log::debug!("pty_write id={id} failed: {e}");
        e
    })
}

#[tauri::command]
pub fn pty_output_ack(state: tauri::State<PtyState>, id: u32, bytes: usize) {
    if bytes == 0 {
        return;
    }
    if let Some(session) = state.sessions.read().get(&id).cloned() {
        session.acknowledge_output(bytes);
    }
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state.sessions.read().get(&id).cloned().ok_or_else(|| {
        log::warn!("pty_resize: unknown id={id}");
        "no session".to_string()
    })?;
    session.resize(cols, rows).map_err(|e| {
        log::warn!("pty_resize id={id} failed: {e}");
        e
    })
}

#[tauri::command]
pub fn pty_close(
    app: tauri::AppHandle,
    state: tauri::State<PtyState>,
    preview_state: tauri::State<crate::modules::preview::PreviewWindowState>,
    hooks_state: tauri::State<HookListenerState>,
    id: u32,
) -> Result<(), String> {
    preview_state.close_tunnels_for_pty(&app, id);
    let session = state.sessions.write().remove(&id);
    let removed_logical: Option<String> = {
        let mut ls = state.logical_sessions.write();
        let key = ls
            .iter()
            .find(|(_, sid)| **sid == id)
            .map(|(k, _)| k.clone());
        if let Some(ref k) = key {
            ls.remove(k);
        }
        key
    };
    if let Some(ref lid) = removed_logical {
        wrapper::cleanup_hooks_settings(lid, hooks_state.agent_config_dir());
    }
    if let Some(s) = session {
        if let Err(e) = s.kill() {
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn ten_live_local_sessions_echo_input_exit_and_leave_no_registry_entries() {
        const SESSION_COUNT: usize = 10;
        let state = PtyState::default();
        let mut probes = Vec::with_capacity(SESSION_COUNT);

        for index in 0..SESSION_COUNT {
            let logical_id = format!("m0-live-{index}");
            let marker = format!("__TUNARA_M0_{index}__");
            let (tx, rx) = mpsc::channel();
            let channel = Channel::<PtyEvent>::new(move |body| {
                let _ = tx.send(body);
                Ok(())
            });
            let (session, _) = session::spawn(80, 24, None, channel, Some(&logical_id), None)
                .expect("spawn real local shell");
            let id = state.insert(session, Some(&logical_id));
            probes.push((id, marker, rx));
        }

        for (id, marker, _) in &probes {
            let command = format!("printf '%s\\n' '{marker}'; exit\n");
            state
                .get(*id)
                .expect("registered live session")
                .write(command.as_bytes())
                .expect("write marker to PTY");
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        for (_, marker, rx) in probes {
            let mut output = Vec::new();
            let mut exited = false;
            while !exited && Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let body = rx
                    .recv_timeout(remaining)
                    .expect("PTY event before deadline");
                let InvokeResponseBody::Json(json) = body else {
                    continue;
                };
                let event: serde_json::Value =
                    serde_json::from_str(&json).expect("valid event JSON");
                match event.get("type").and_then(serde_json::Value::as_str) {
                    Some("data") => {
                        let encoded = event
                            .get("data")
                            .and_then(serde_json::Value::as_str)
                            .expect("data event payload");
                        output.extend(B64.decode(encoded).expect("base64 PTY output"));
                    }
                    Some("exit") => exited = true,
                    _ => {}
                }
            }
            assert!(exited, "session did not emit Exit before deadline");
            assert!(
                String::from_utf8_lossy(&output).contains(&marker),
                "session output did not contain its unique marker"
            );
        }

        state.close_all();
        assert!(state.sessions.read().is_empty());
        assert!(state.logical_sessions.read().is_empty());
    }

    #[test]
    fn high_output_is_backpressured_without_dropping_protocol_bytes() {
        const PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
        const MARKER: &str = "__TUNARA_LOCAL_HIGH_OUTPUT_OK__";
        let (tx, rx) = mpsc::channel();
        let channel = Channel::<PtyEvent>::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let (session, _) = session::spawn(80, 24, None, channel, Some("m1-local-output"), None)
            .expect("spawn real local shell");
        session
            .write(
                format!(
                    "stty -echo -onlcr; head -c {PAYLOAD_BYTES} /dev/zero | tr '\\0' x; printf '\\n{MARKER}\\n'; exit\n"
                )
                .as_bytes(),
            )
            .expect("start high-output fixture");

        let deadline = Instant::now() + Duration::from_secs(30);
        let mut output = Vec::with_capacity(PAYLOAD_BYTES + 4096);
        let mut data_events = 0usize;
        let mut largest_event = 0usize;
        let mut exited = false;
        while !exited && Instant::now() < deadline {
            let body = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("PTY event before high-output deadline");
            let InvokeResponseBody::Json(json) = body else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(&json).expect("valid event JSON");
            match event.get("type").and_then(serde_json::Value::as_str) {
                Some("data") => {
                    let encoded = event
                        .get("data")
                        .and_then(serde_json::Value::as_str)
                        .expect("data event payload");
                    let bytes = B64.decode(encoded).expect("base64 PTY output");
                    session.acknowledge_output(bytes.len());
                    largest_event = largest_event.max(bytes.len());
                    data_events += 1;
                    output.extend(bytes);
                }
                Some("exit") => exited = true,
                _ => {}
            }
        }

        assert!(exited, "high-output session did not emit Exit");
        assert!(data_events > 1, "fixture should exercise output batching");
        assert!(
            largest_event <= session::OUTPUT_BATCH_MAX,
            "Data event exceeded the byte cap: {largest_event}"
        );
        assert!(
            output.iter().filter(|byte| **byte == b'x').count() >= PAYLOAD_BYTES,
            "high-output payload was truncated"
        );
        assert!(
            String::from_utf8_lossy(&output).contains(MARKER),
            "final marker was not delivered"
        );
        assert!(
            !String::from_utf8_lossy(&output).contains("dropped output due to backpressure"),
            "backpressure must not delete output"
        );
    }
}
