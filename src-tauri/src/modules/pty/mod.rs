mod session;
mod shell_init;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use portable_pty::PtySize;
use tauri::ipc::Channel;

pub use session::PtyEvent;
use session::Session;

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
        let sessions: Vec<(u32, Arc<Session>)> = self
            .sessions
            .write()
            .expect("pty sessions lock poisoned")
            .drain()
            .collect();
        self.logical_sessions
            .write()
            .expect("pty logical sessions lock poisoned")
            .clear();
        for (id, session) in sessions {
            if let Err(e) = session
                .killer
                .lock()
                .expect("pty killer lock poisoned")
                .kill()
            {
                log::debug!("pty close_all: kill id={id} returned {e}");
            }
            log::info!("pty closed id={id}");
        }
    }
}

#[tauri::command]
pub fn pty_open(
    state: tauri::State<PtyState>,
    logical_session_id: Option<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    if let Some(logical_id) = logical_session_id.as_deref() {
        let old_id = state
            .logical_sessions
            .write()
            .expect("pty logical sessions lock poisoned")
            .remove(logical_id);
        if let Some(old_id) = old_id {
            let old_session = state
                .sessions
                .write()
                .expect("pty sessions lock poisoned")
                .remove(&old_id);
            if let Some(session) = old_session {
                if let Err(e) = session
                    .killer
                    .lock()
                    .expect("pty killer lock poisoned")
                    .kill()
                {
                    log::debug!("pty_open replace: kill id={old_id} returned {e}");
                }
                log::info!("pty replaced id={old_id} logical_session_id={logical_id}");
            }
        }
    }

    let (session, _) = session::spawn(cols, rows, cwd, on_event).map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state
        .sessions
        .write()
        .expect("pty sessions lock poisoned")
        .insert(id, session);
    if let Some(logical_id) = logical_session_id {
        state
            .logical_sessions
            .write()
            .expect("pty logical sessions lock poisoned")
            .insert(logical_id.clone(), id);
        log::info!("pty opened id={id} logical_session_id={logical_id} cols={cols} rows={rows}");
    } else {
        log::info!("pty opened id={id} cols={cols} rows={rows}");
    }
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: tauri::State<PtyState>, id: u32, data: String) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .expect("pty sessions lock poisoned")
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // Bind to a local so the MutexGuard temporary drops before `session` —
    // see rustc note on tail-expression temporary drop order.
    let result = session
        .writer
        .lock()
        .expect("pty writer lock poisoned")
        .write_all(data.as_bytes())
        .map_err(|e| {
            // EPIPE is expected if the child already exited.
            log::debug!("pty_write id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .expect("pty sessions lock poisoned")
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .master
        .lock()
        .expect("pty master lock poisoned")
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e.to_string()
        });
    result
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    let session = state
        .sessions
        .write()
        .expect("pty sessions lock poisoned")
        .remove(&id);
    state
        .logical_sessions
        .write()
        .expect("pty logical sessions lock poisoned")
        .retain(|_, session_id| *session_id != id);
    if let Some(s) = session {
        if let Err(e) = s.killer.lock().expect("pty killer lock poisoned").kill() {
            // Non-fatal: the child may already have exited on its own (e.g. the
            // user ran `exit`). Log so this isn't invisible during debugging.
            log::debug!("pty_close: kill id={id} returned {e}");
        }
        log::info!("pty closed id={id}");
    } else {
        log::debug!("pty_close: unknown id={id}");
    }
    Ok(())
}
