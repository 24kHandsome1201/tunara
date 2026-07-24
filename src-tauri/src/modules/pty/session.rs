use std::io::{Read, Write};
use std::sync::{mpsc, Arc};
use std::thread;

use parking_lot::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use super::output_flow::OutputFlow;
use super::shell_init;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardInteractivePrompt {
    pub prompt: String,
    pub echo: bool,
}

const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const READ_BUF: usize = 8 * 1024;
// Reader-to-flusher memory is bounded to about 1 MiB. When it fills, the
// reader blocks and the kernel PTY applies backpressure to the child instead
// of Tunara deleting an arbitrary span of terminal protocol bytes.
const OUTPUT_QUEUE_MESSAGES: usize = 128;
pub(super) const OUTPUT_BATCH_MAX: usize = 128 * 1024;

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data {
        data: String,
    },
    /// The SSH transport disappeared without a remote exit or a local close.
    /// `reason` is a stable machine-readable value, never a raw network error.
    TransportLost {
        reason: String,
    },
    Exit {
        code: i32,
    },
    /// Fine-grained SSH open progress. Local PTYs use renderer-owned opening
    /// and ready evidence because their spawn is synchronous.
    ConnectionStatus {
        phase: String,
    },
    /// An unknown/unverifiable SSH host key needs the user to confirm the
    /// fingerprint before the connection proceeds (TOFU). The frontend shows a
    /// dialog and replies via the `ssh_host_key_decision` command keyed by
    /// `prompt_id`. Emitted only on the SSH path.
    #[serde(rename_all = "camelCase")]
    HostKeyPrompt {
        prompt_id: String,
        host: String,
        port: u16,
        fingerprint: String,
        key_type: String,
        /// Why we're prompting, so the dialog can tell the user the truth:
        /// `"unknown"` = genuine first contact (accepting persists to
        /// known_hosts); `"unverifiable"` = host is already in known_hosts but
        /// its key couldn't be confirmed against the stored (hashed/wildcard)
        /// entry — a possible key rotation or MITM, and accepting does NOT
        /// persist. Conflating these two trains reflexive trust.
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    KeyboardInteractivePrompt {
        prompt_id: String,
        name: String,
        instructions: String,
        prompts: Vec<KeyboardInteractivePrompt>,
    },
}

/// A terminal session backend. Both variants feed xterm.js through the same
/// `PtyEvent` channel, so the `pty_write` / `pty_resize` / `pty_close`
/// commands dispatch on this enum without the frontend caring which it is.
pub enum Session {
    /// Local login shell over a real PTY (portable-pty).
    Local(LocalSession),
    /// Remote interactive shell over an SSH channel (russh).
    Ssh(crate::modules::ssh::connection::SshSession),
}

impl Session {
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        match self {
            Session::Local(s) => s.writer.lock().write_all(data).map_err(|e| e.to_string()),
            Session::Ssh(s) => s.write(data),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self {
            Session::Local(s) => s
                .master
                .lock()
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string()),
            Session::Ssh(s) => s.resize(cols, rows),
        }
    }

    /// Terminate the session. For local that's killing the child; for SSH it
    /// closes the channel (the connection drops with the SshSession). Both
    /// variants propagate their teardown error so callers log failures
    /// symmetrically.
    pub fn kill(&self) -> Result<(), String> {
        match self {
            Session::Local(s) => {
                s.output_flow.close();
                s.killer.lock().kill().map_err(|e| e.to_string())
            }
            Session::Ssh(s) => s.close(),
        }
    }

    pub fn acknowledge_output(&self, bytes: usize) {
        match self {
            Session::Local(s) => s.output_flow.acknowledge(bytes),
            Session::Ssh(s) => s.acknowledge_output(bytes),
        }
    }
}

/// Local PTY-backed session: master (for resize), writer (for input), killer.
pub struct LocalSession {
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output_flow: Arc<OutputFlow>,
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        self.output_flow.close();
        let _ = self.killer.lock().kill();
    }
}

pub fn spawn(
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_event: Channel<PtyEvent>,
    session_id: Option<&str>,
    sock_path: Option<&str>,
) -> Result<(Arc<Session>, PtySize), String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system.openpty(size).map_err(|e| e.to_string())?;

    let cmd = shell_init::build_command(cwd, session_id, sock_path)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let flusher_killer = Arc::new(Mutex::new(child.clone_killer()));
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let output_flow = OutputFlow::new();
    let session = Arc::new(Session::Local(LocalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        output_flow: output_flow.clone(),
    }));

    let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(OUTPUT_QUEUE_MESSAGES);

    let reader_thread = thread::Builder::new()
        .name("tunara-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        // Normal on child exit: the slave fd is closed and
                        // read(2) returns EIO on some platforms. Kept at debug
                        // to avoid noise in the common case.
                        log::debug!("pty reader ended: {e}");
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("spawn pty reader thread: {e}"))?;

    let on_event_flush = on_event.clone();
    let killer_f = flusher_killer.clone();
    let output_flow_f = output_flow;
    let flusher_thread = thread::Builder::new()
        .name("tunara-pty-flusher".into())
        .spawn(move || {
            let mut carry = None;
            loop {
                let first = match carry.take() {
                    Some(bytes) => bytes,
                    None => match output_rx.recv() {
                        Ok(bytes) => bytes,
                        Err(_) => break,
                    },
                };
                let mut chunk = Vec::with_capacity(OUTPUT_BATCH_MAX);
                chunk.extend_from_slice(&first);
                let deadline = Instant::now() + FLUSH_INTERVAL;
                let mut disconnected = false;
                while chunk.len() < OUTPUT_BATCH_MAX {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match output_rx.recv_timeout(remaining) {
                        Ok(bytes) if chunk.len() + bytes.len() <= OUTPUT_BATCH_MAX => {
                            chunk.extend_from_slice(&bytes);
                        }
                        Ok(bytes) => {
                            carry = Some(bytes);
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                    }
                }
                // NOTE on base64: Tauri v2 `Channel<T>` serializes via JSON;
                // `Vec<u8>` would become a JSON int array (~3× worse than base64).
                let event = PtyEvent::Data {
                    data: B64.encode(&chunk),
                };
                if !output_flow_f.reserve_blocking(chunk.len()) {
                    break;
                }
                if let Err(e) = on_event_flush.send(event) {
                    output_flow_f.acknowledge(chunk.len());
                    output_flow_f.close();
                    log::debug!("pty flusher exiting, channel closed: {e}");
                    let _ = killer_f.lock().kill();
                    break;
                }
                if disconnected && carry.is_none() {
                    break;
                }
            }
        })
        .map_err(|e| format!("spawn pty flusher thread: {e}"))?;

    let on_event_exit = on_event;
    let waiter_spawn = thread::Builder::new()
        .name("tunara-pty-waiter".into())
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(e) => {
                    log::warn!("pty child wait failed: {e}");
                    -1
                }
            };
            // Wait for the reader to hit EOF, then drain the bounded queue.
            // Joining the flusher guarantees every Data event is sent before
            // Exit, so output cannot land below the frontend exit banner.
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            if let Err(e) = flusher_thread.join() {
                log::error!("pty flusher thread panicked: {e:?}");
            }
            if let Err(e) = on_event_exit.send(PtyEvent::Exit { code }) {
                log::debug!("pty exit send failed (channel closed): {e}");
            }
        });
    if let Err(e) = waiter_spawn {
        // Returning Err drops `session`, whose Drop kills the child. The reader
        // then drops its sender and the flusher drains the queue before exiting.
        return Err(format!("spawn pty waiter thread: {e}"));
    }

    Ok((session, size))
}
