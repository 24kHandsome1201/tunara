use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use portable_pty::{native_pty_system, ChildKiller, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use super::shell_init;

const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const READ_BUF: usize = 8 * 1024;
// Cap on buffered-but-not-yet-flushed bytes. On overflow we discard the
// entire pending buffer and emit an SGR-reset + notice in its place.
// Dropping a partial prefix would slice a CSI sequence in half and corrupt
// xterm's screen state. 1 MiB is ~250 full 80x24 screens.
const MAX_PENDING: usize = 1024 * 1024;
// Hard reset (ESC c) + dim notice. Written verbatim into the stream when
// we're forced to discard backlog.
const OVERFLOW_NOTICE: &[u8] =
    b"\x1bc\x1b[2m[tunara: dropped output due to backpressure]\x1b[0m\r\n";

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Data {
        data: String,
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
            Session::Local(s) => s.killer.lock().kill().map_err(|e| e.to_string()),
            Session::Ssh(s) => s.close(),
        }
    }
}

/// Local PTY-backed session: master (for resize), writer (for input), killer.
pub struct LocalSession {
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub writer: Mutex<Box<dyn Write + Send>>,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

impl Drop for LocalSession {
    fn drop(&mut self) {
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

    let session = Arc::new(Session::Local(LocalSession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
    }));

    let pending: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::with_capacity(READ_BUF)));
    let done = Arc::new(AtomicBool::new(false));

    let pending_r = pending.clone();
    let reader_thread = thread::Builder::new()
        .name("tunara-pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; READ_BUF];
            let mut dropped_bytes: u64 = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut g = pending_r.lock();
                        if g.len() + n > MAX_PENDING {
                            // Discard the whole backlog rather than slicing
                            // through escape sequences. Emit a hard reset so
                            // xterm doesn't carry stale SGR/cursor state.
                            dropped_bytes += g.len() as u64;
                            g.clear();
                            g.extend_from_slice(OVERFLOW_NOTICE);
                        }
                        g.extend_from_slice(&buf[..n]);
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
            if dropped_bytes > 0 {
                log::warn!("pty backpressure: dropped {dropped_bytes} bytes (cap {MAX_PENDING})");
            }
        })
        .map_err(|e| format!("spawn pty reader thread: {e}"))?;

    let on_event_flush = on_event.clone();
    let pending_f = pending.clone();
    let done_f = done.clone();
    let killer_f = flusher_killer.clone();
    let flusher_thread = thread::Builder::new()
        .name("tunara-pty-flusher".into())
        .spawn(move || loop {
            thread::sleep(FLUSH_INTERVAL);
            let chunk = {
                let mut g = pending_f.lock();
                if g.is_empty() {
                    if done_f.load(Ordering::Acquire) {
                        break;
                    }
                    continue;
                }
                std::mem::take(&mut *g)
            };
            // NOTE on base64: Tauri v2 `Channel<T>` serializes via JSON;
            // `Vec<u8>` would become a JSON int array (~3× worse than base64).
            // A raw-bytes path via `InvokeResponseBody::Raw` exists but the
            // data+exit multiplex through one channel is awkward. Base64's 33%
            // overhead is trivial on local IPC — revisit if profiling says
            // otherwise.
            let event = PtyEvent::Data {
                data: B64.encode(&chunk),
            };
            if let Err(e) = on_event_flush.send(event) {
                log::debug!("pty flusher exiting, channel closed: {e}");
                let _ = killer_f.lock().kill();
                break;
            }
        })
        .map_err(|e| format!("spawn pty flusher thread: {e}"))?;

    let on_event_exit = on_event;
    let pending_e = pending;
    // Clone (not move) so a strong ref to `done` survives outside the waiter
    // closure for the spawn-failure cleanup path below.
    let done_e = done.clone();
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
            // Wait for the reader to hit EOF so `pending` stops growing, then
            // drain the flusher before taking a final snapshot. Setting `done`
            // and joining the flusher guarantees every Data it had taken is sent
            // before we emit Exit — otherwise a chunk the flusher grabbed but
            // hadn't yet encoded could land AFTER Exit, appending output below
            // the "[process exited]" line on the frontend.
            if let Err(e) = reader_thread.join() {
                log::error!("pty reader thread panicked: {e:?}");
            }
            done_e.store(true, Ordering::Release);
            // The flusher loop breaks once `pending` is empty AND `done` is set,
            // so on join it has flushed everything it took. Costs at most one
            // FLUSH_INTERVAL of extra latency on Exit — negligible.
            if let Err(e) = flusher_thread.join() {
                log::error!("pty flusher thread panicked: {e:?}");
            }
            // Any residue (almost always empty now) is sent before Exit so the
            // Exit event is guaranteed last on this channel.
            let tail = std::mem::take(&mut *pending_e.lock());
            if !tail.is_empty() {
                if let Err(e) = on_event_exit.send(PtyEvent::Data {
                    data: B64.encode(&tail),
                }) {
                    log::debug!("pty final-data send failed (channel closed): {e}");
                }
            }
            if let Err(e) = on_event_exit.send(PtyEvent::Exit { code }) {
                log::debug!("pty exit send failed (channel closed): {e}");
            }
        });
    if let Err(e) = waiter_spawn {
        // The reader + flusher threads are already running. Returning Err drops
        // `session`, whose Drop kills the child, so the reader hits EOF and
        // exits. But the flusher only breaks when it sees `pending` empty AND
        // `done` set, and `done` is otherwise set solely inside the waiter
        // closure that never spawned — so without this the flusher would spin
        // every FLUSH_INTERVAL forever, one leaked thread per failed spawn. Set
        // it here so the flusher observes `done` and exits cleanly.
        done.store(true, Ordering::Release);
        return Err(format!("spawn pty waiter thread: {e}"));
    }

    Ok((session, size))
}
