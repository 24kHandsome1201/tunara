//! Terminal session backend: the PTY/SSH multiplexer the frontend drives.
//!
//! [`PtyState`] holds every live session: a `HashMap<u32, Arc<Session>>` keyed
//! by physical id, a `logical_id -> physical_id` map for the reopen/replace
//! path, and a monotonic `next_id` (starts at 1; ids are never reused). The
//! [`Session`] enum (`Local` portable-pty | `Ssh` russh) lets `pty_write` /
//! `pty_resize` / `pty_close` dispatch on the variant, so the SSH path
//! (`ssh_open_v2` inserting a `Session::Ssh`) reuses the same commands.
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

use parking_lot::{Condvar, Mutex, RwLock};

use tauri::ipc::Channel;
use tokio::sync::watch;

pub use session::Session;
pub use session::{
    HostKeyPersistenceStatus, KeyboardInteractiveOrigin, KeyboardInteractivePrompt, PtyEvent,
};

use super::agent::hooks::HookListenerState;
use super::agent::wrapper;

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    logical_sessions: RwLock<HashMap<String, u32>>,
    /// Authoritative backend-owned SSH binding registry. A binding is inserted
    /// in the same publication critical section as its session and removed on
    /// every replacement/close path; no second generation registry exists.
    ssh_bindings: RwLock<HashMap<u32, Arc<BindingEntry>>>,
    binding_mutation: Mutex<()>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            logical_sessions: RwLock::new(HashMap::new()),
            ssh_bindings: RwLock::new(HashMap::new()),
            binding_mutation: Mutex::new(()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl PtyState {
    fn retire(entry: Option<Arc<BindingEntry>>) {
        if let Some(entry) = entry {
            let drain_started = std::time::Instant::now();
            let mut state = entry.state.lock();
            state.valid = false;
            let _ = entry.retired.send(true);
            while state.active != 0 {
                entry.drained.wait(&mut state);
            }
            let drain_micros = drain_started
                .elapsed()
                .as_micros()
                .min(u128::from(u64::MAX)) as u64;
            crate::modules::perf_counters::binding_lease_drain(drain_micros);
            if drain_micros > 500_000 {
                log::warn!("SSH binding commit leases took {drain_micros}us to drain");
            }
        }
    }

    pub fn close_all(&self) {
        let _mutation = self.binding_mutation.lock();
        let entries: Vec<_> = self.ssh_bindings.write().drain().map(|(_, e)| e).collect();
        for entry in entries {
            Self::retire(Some(entry));
        }
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
    /// pty_open and ssh_open_v2 on the reopen/replace path.
    pub fn remove_logical(&self, logical_id: &str) {
        let _mutation = self.binding_mutation.lock();
        let old_id = self.logical_sessions.read().get(logical_id).copied();
        let entry = old_id.and_then(|id| self.ssh_bindings.write().remove(&id));
        Self::retire(entry);
        let removed = {
            let mut sessions = self.sessions.write();
            let mut logical = self.logical_sessions.write();
            logical
                .remove(logical_id)
                .map(|old_id| (old_id, sessions.remove(&old_id)))
        };
        if let Some((old_id, Some(session))) = removed {
            if let Err(e) = session.kill() {
                log::debug!("remove_logical: kill id={old_id} returned {e}");
            }
            log::info!("session replaced id={old_id} logical_session_id={logical_id}");
        }
    }

    /// Look up a live session by physical id (used by the SFTP commands to
    /// reach the SSH connection behind a session).
    pub fn get(&self, id: u32) -> Option<Arc<Session>> {
        self.sessions.read().get(&id).cloned()
    }

    /// Find a live SSH transport that a new shell can multiplex onto.
    #[allow(clippy::too_many_arguments)]
    pub fn find_shareable_ssh(
        &self,
        host: &str,
        port: u16,
        user: &str,
        identity_file: Option<&str>,
        jump_endpoint: Option<&(String, u16, String)>,
        exclude_logical_id: Option<&str>,
        prefer_logical_id: Option<&str>,
    ) -> Option<crate::modules::ssh::connection::SharedSshTransport> {
        let sessions = self.sessions.read();
        if let Some(prefer) = prefer_logical_id {
            if let Some(physical) = self.logical_sessions.read().get(prefer).copied() {
                if let Some(session) = sessions.get(&physical) {
                    if let Session::Ssh(ssh) = session.as_ref() {
                        if ssh.matches_transport(
                            host,
                            port,
                            user,
                            identity_file,
                            jump_endpoint,
                            exclude_logical_id,
                        ) {
                            if let Some(shared) = ssh.share_transport() {
                                return Some(shared);
                            }
                        }
                    }
                }
            }
        }
        for session in sessions.values() {
            let Session::Ssh(ssh) = session.as_ref() else {
                continue;
            };
            if ssh.matches_transport(
                host,
                port,
                user,
                identity_file,
                jump_endpoint,
                exclude_logical_id,
            ) {
                if let Some(shared) = ssh.share_transport() {
                    return Some(shared);
                }
            }
        }
        None
    }

    /// Atomically validate all three components of a backend-issued binding
    /// and acquire its live session. A stale generation can never alias a
    /// replacement because physical ids and generations are never reused.
    #[allow(dead_code)] // public seam consumed by upcoming binding-aware commands
    pub fn get_for_ssh_binding(
        &self,
        binding: &crate::modules::ssh::diagnostics::SessionBindingV1,
    ) -> Option<Arc<Session>> {
        crate::modules::perf_counters::binding_lock_acquisition();
        let sessions = self.sessions.read();
        let logical = self.logical_sessions.read();
        let bindings = self.ssh_bindings.read();
        let registered = bindings.get(&binding.physical_pty_id)?;
        if registered.binding != *binding
            || logical.get(&binding.logical_session_id) != Some(&binding.physical_pty_id)
        {
            return None;
        }
        sessions.get(&binding.physical_pty_id).cloned()
    }

    pub fn acquire_commit_lease(
        &self,
        binding: &crate::modules::ssh::diagnostics::SessionBindingV1,
    ) -> Result<CommitLease, String> {
        crate::modules::perf_counters::binding_lock_acquisition();
        let logical = self.logical_sessions.read();
        let bindings = self.ssh_bindings.read();
        let entry = bindings
            .get(&binding.physical_pty_id)
            .filter(|entry| entry.binding == *binding)
            .filter(|_| logical.get(&binding.logical_session_id) == Some(&binding.physical_pty_id))
            .cloned()
            .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
        let mut state = entry.state.lock();
        if !state.valid {
            return Err("stale or invalid SSH session binding".into());
        }
        state.active += 1;
        drop(state);
        Ok(CommitLease { entry })
    }

    /// Subscribe to retirement of the exact, currently authoritative binding.
    /// Locking the entry state through subscription closes the race with
    /// retirement: either this rejects an invalid entry or its receiver sees
    /// the subsequent `true` notification.
    pub fn subscribe_binding_retired(
        &self,
        binding: &crate::modules::ssh::diagnostics::SessionBindingV1,
    ) -> Result<watch::Receiver<bool>, String> {
        crate::modules::perf_counters::binding_lock_acquisition();
        let logical = self.logical_sessions.read();
        let bindings = self.ssh_bindings.read();
        let entry = bindings
            .get(&binding.physical_pty_id)
            .filter(|entry| entry.binding == *binding)
            .filter(|_| logical.get(&binding.logical_session_id) == Some(&binding.physical_pty_id))
            .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
        let state = entry.state.lock();
        if !state.valid {
            return Err("stale or invalid SSH session binding".into());
        }
        let receiver = entry.retired.subscribe();
        drop(state);
        Ok(receiver)
    }

    /// Resolve the physical PTY currently owned by a logical frontend session.
    /// Preview evidence uses this to avoid writing to whichever terminal happens
    /// to be selected when the user presses Send.
    pub fn physical_for_logical(&self, logical_id: &str) -> Option<u32> {
        self.logical_sessions.read().get(logical_id).copied()
    }

    /// Register an already-built session under a fresh id, optionally bound to a
    /// logical id, replacing (and killing) any session already bound to that
    /// logical id. Returns the physical id. Used by both pty_open and ssh_open_v2.
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
        let _mutation = self.binding_mutation.lock();
        let old_entry = logical_id
            .and_then(|lid| self.logical_sessions.read().get(lid).copied())
            .and_then(|id| self.ssh_bindings.write().remove(&id));
        Self::retire(old_entry);
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

    /// Publish an SSH session and its complete backend-authored binding in one
    /// critical section. Empty generations are rejected before any map changes.
    pub fn insert_ssh(
        &self,
        session: Arc<Session>,
        logical_id: &str,
        transport_generation: String,
    ) -> Result<crate::modules::ssh::diagnostics::SessionBindingV1, String> {
        if logical_id.is_empty() || transport_generation.is_empty() {
            return Err("SSH binding requires logical session id and generation".into());
        }
        let _mutation = self.binding_mutation.lock();
        let old_entry = self
            .logical_sessions
            .read()
            .get(logical_id)
            .copied()
            .and_then(|id| self.ssh_bindings.write().remove(&id));
        Self::retire(old_entry);
        let mut sessions = self.sessions.write();
        let mut logical = self.logical_sessions.write();
        let mut bindings = self.ssh_bindings.write();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Some(old_id) = logical.insert(logical_id.to_string(), id) {
            if let Some(old) = sessions.remove(&old_id) {
                if let Err(e) = old.kill() {
                    log::debug!("insert_ssh: kill replaced id={old_id} returned {e}");
                }
                log::info!("session replaced id={old_id} logical_session_id={logical_id}");
            }
        }
        let binding = crate::modules::ssh::diagnostics::SessionBindingV1 {
            logical_session_id: logical_id.to_string(),
            physical_pty_id: id,
            transport_generation,
        };
        sessions.insert(id, session);
        bindings.insert(id, Arc::new(BindingEntry::new(binding.clone())));
        Ok(binding)
    }

    #[cfg(test)]
    pub(crate) fn insert_test_binding(
        &self,
        logical_id: &str,
        transport_generation: &str,
    ) -> (
        crate::modules::ssh::diagnostics::SessionBindingV1,
        Arc<Session>,
    ) {
        let channel = Channel::<PtyEvent>::new(|_| Ok(()));
        let session = session::spawn(80, 24, None, channel, Some(logical_id), None)
            .expect("spawn binding fixture")
            .0;
        let binding = self
            .insert_ssh(
                Arc::clone(&session),
                logical_id,
                transport_generation.to_string(),
            )
            .expect("insert test binding");
        (binding, session)
    }
}

struct BindingEntry {
    binding: crate::modules::ssh::diagnostics::SessionBindingV1,
    state: Mutex<LeaseState>,
    drained: Condvar,
    retired: watch::Sender<bool>,
}
struct LeaseState {
    valid: bool,
    active: usize,
}
impl BindingEntry {
    fn new(binding: crate::modules::ssh::diagnostics::SessionBindingV1) -> Self {
        let (retired, _) = watch::channel(false);
        Self {
            binding,
            state: Mutex::new(LeaseState {
                valid: true,
                active: 0,
            }),
            drained: Condvar::new(),
            retired,
        }
    }
}
pub struct CommitLease {
    entry: Arc<BindingEntry>,
}
impl Drop for CommitLease {
    fn drop(&mut self) {
        let mut state = self.entry.state.lock();
        state.active -= 1;
        if state.active == 0 {
            self.entry.drained.notify_all();
        }
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
        crate::modules::ssh::cancel_pending_open_for_logical(logical_id);
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
    let _mutation = state.binding_mutation.lock();
    let entry = state.ssh_bindings.write().remove(&id);
    PtyState::retire(entry);
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

    fn binding_test_session(logical_id: &str) -> Arc<Session> {
        let channel = Channel::<PtyEvent>::new(|_| Ok(()));
        session::spawn(80, 24, None, channel, Some(logical_id), None)
            .expect("spawn binding fixture")
            .0
    }

    #[test]
    fn host_key_persistence_status_wire_values_are_stable() {
        for (status, expected) in [
            (HostKeyPersistenceStatus::Saved, "saved"),
            (HostKeyPersistenceStatus::SessionOnly, "sessionOnly"),
            (
                HostKeyPersistenceStatus::PreCommitFailure,
                "preCommitFailure",
            ),
            (
                HostKeyPersistenceStatus::CommittedButDurabilityUnknown,
                "committedButDurabilityUnknown",
            ),
        ] {
            let event = serde_json::to_value(PtyEvent::HostKeyPersistence {
                host: "example.test".into(),
                port: 22,
                status,
            })
            .unwrap();
            assert_eq!(event["type"], "hostKeyPersistence");
            assert_eq!(event["status"], expected);
        }
    }

    #[test]
    fn ssh_binding_registry_rejects_wrong_stale_and_removed_bindings() {
        let state = PtyState::default();
        let rejected = state.insert_ssh(
            binding_test_session("binding-empty"),
            "binding-empty",
            String::new(),
        );
        assert!(
            rejected.is_err(),
            "generation must exist before publication"
        );
        assert!(state.physical_for_logical("binding-empty").is_none());

        let first = state
            .insert_ssh(
                binding_test_session("binding-live"),
                "binding-live",
                "generation-one".into(),
            )
            .expect("publish first binding");
        assert!(state.get_for_ssh_binding(&first).is_some());

        let mut wrong_logical = first.clone();
        wrong_logical.logical_session_id = "binding-other".into();
        assert!(state.get_for_ssh_binding(&wrong_logical).is_none());
        let mut wrong_physical = first.clone();
        wrong_physical.physical_pty_id = wrong_physical.physical_pty_id.saturating_add(1);
        assert!(state.get_for_ssh_binding(&wrong_physical).is_none());
        let mut wrong_generation = first.clone();
        wrong_generation.transport_generation = "generation-wrong".into();
        assert!(state.get_for_ssh_binding(&wrong_generation).is_none());

        let second = state
            .insert_ssh(
                binding_test_session("binding-live"),
                "binding-live",
                "generation-two".into(),
            )
            .expect("replace binding");
        assert!(state.get_for_ssh_binding(&first).is_none());
        assert!(state.get_for_ssh_binding(&second).is_some());

        state.remove_logical("binding-live");
        assert!(state.get_for_ssh_binding(&second).is_none());

        let closing = state
            .insert_ssh(
                binding_test_session("binding-close-all"),
                "binding-close-all",
                "generation-three".into(),
            )
            .expect("publish close-all binding");
        state.close_all();
        assert!(state.get_for_ssh_binding(&closing).is_none());
    }

    #[test]
    fn replacement_invalidates_old_commit_generation() {
        let state = PtyState::default();
        let first = state
            .insert_ssh(binding_test_session("lease"), "lease", "one".into())
            .unwrap();
        drop(state.acquire_commit_lease(&first).unwrap());
        let second = state
            .insert_ssh(binding_test_session("lease"), "lease", "two".into())
            .unwrap();
        assert!(state.acquire_commit_lease(&first).is_err());
        assert!(state.acquire_commit_lease(&second).is_ok());
    }

    #[test]
    fn binding_retirement_subscription_observes_replacement() {
        let state = PtyState::default();
        let first = state
            .insert_ssh(binding_test_session("watch"), "watch", "one".into())
            .unwrap();
        let mut retired = state.subscribe_binding_retired(&first).unwrap();
        assert!(!*retired.borrow());

        let second = state
            .insert_ssh(binding_test_session("watch"), "watch", "two".into())
            .unwrap();

        assert!(*retired.borrow_and_update());
        assert!(
            retired.has_changed().is_err(),
            "retired entry drops its final sender after replacement"
        );
        assert!(state.subscribe_binding_retired(&first).is_err());
        assert!(state.subscribe_binding_retired(&second).is_ok());
    }

    #[test]
    fn binding_retirement_subscription_observes_remove_and_close_all() {
        let state = PtyState::default();
        let removed = state
            .insert_ssh(
                binding_test_session("watch-remove"),
                "watch-remove",
                "one".into(),
            )
            .unwrap();
        let removed_retired = state.subscribe_binding_retired(&removed).unwrap();
        state.remove_logical("watch-remove");
        assert!(*removed_retired.borrow());

        let closed = state
            .insert_ssh(
                binding_test_session("watch-close-all"),
                "watch-close-all",
                "two".into(),
            )
            .unwrap();
        let closed_retired = state.subscribe_binding_retired(&closed).unwrap();
        state.close_all();
        assert!(*closed_retired.borrow());
    }

    #[test]
    fn binding_retirement_subscription_rejects_invalid_entry() {
        let state = PtyState::default();
        let binding = state
            .insert_ssh(
                binding_test_session("invalid-watch"),
                "invalid-watch",
                "one".into(),
            )
            .unwrap();
        let entry = state
            .ssh_bindings
            .read()
            .get(&binding.physical_pty_id)
            .cloned()
            .unwrap();
        PtyState::retire(Some(entry));

        assert!(state.subscribe_binding_retired(&binding).is_err());
    }

    #[test]
    fn binding_retirement_signal_precedes_commit_lease_drain() {
        let state = Arc::new(PtyState::default());
        let binding = state
            .insert_ssh(
                binding_test_session("drain-watch"),
                "drain-watch",
                "one".into(),
            )
            .unwrap();
        let lease = state.acquire_commit_lease(&binding).unwrap();
        let mut retired = state.subscribe_binding_retired(&binding).unwrap();
        let replacement = binding_test_session("drain-watch");
        let (done_tx, done_rx) = mpsc::channel();
        let replace_state = Arc::clone(&state);
        let handle = std::thread::spawn(move || {
            replace_state
                .insert_ssh(replacement, "drain-watch", "two".into())
                .unwrap();
            done_tx.send(()).unwrap();
        });

        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(retired.changed())
            .expect("retirement sender remains live");
        assert!(*retired.borrow_and_update());
        assert!(
            done_rx.try_recv().is_err(),
            "replacement must still be waiting for the active lease"
        );

        drop(lease);
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("replacement completes after lease drain");
        handle.join().unwrap();
    }

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
