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

    /// Register an already-built session under a fresh id, optionally bound to
    /// a logical id. Returns the physical id. Used by ssh_open.
    pub fn insert(&self, session: Session, logical_id: Option<&str>) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions.write().insert(id, Arc::new(session));
        if let Some(lid) = logical_id {
            self.logical_sessions.write().insert(lid.to_string(), id);
        }
        id
    }
}

#[tauri::command]
pub fn pty_open(
    state: tauri::State<PtyState>,
    hooks_state: tauri::State<HookListenerState>,
    logical_session_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    if let Some(logical_id) = logical_session_id.as_deref() {
        state.remove_logical(logical_id);
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
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().insert(id, session);
    if let Some(logical_id) = logical_session_id {
        state
            .logical_sessions
            .write()
            .insert(logical_id.clone(), id);
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
    state: tauri::State<PtyState>,
    hooks_state: tauri::State<HookListenerState>,
    id: u32,
) -> Result<(), String> {
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
