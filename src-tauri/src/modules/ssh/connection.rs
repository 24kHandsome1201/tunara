// A live SSH connection: one russh `Handle` multiplexing channels.
//
// Phase 1 uses a single interactive shell channel bridged to xterm.js through
// the SAME `PtyEvent` + base64 path the local PTY uses, so the frontend can't
// tell local from remote. The `Handle` is kept alive (later phases open an
// SFTP channel on the same connection).

use std::collections::HashMap;
use std::fmt::Display;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Handle};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::ChannelMsg;
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::{mpsc, oneshot};

use super::auth::{self, AuthOptions};
use super::known_hosts::{self, Verdict};
use crate::modules::pty::PtyEvent;

/// How to handle a host key the store can't confirm (Unknown / Unverifiable).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum HostKeyPolicy {
    /// Ask the user to confirm the fingerprint via a frontend dialog (default,
    /// the safe TOFU behavior). A Match still proceeds silently; a Mismatch is
    /// always refused.
    #[default]
    Prompt,
    /// Accept and persist without asking. Only set when the user has already
    /// confirmed (e.g. an explicit "trust without prompting" opt-in).
    AcceptUnknown,
}

/// Pending host-key confirmations, keyed by a per-prompt id. `check_server_key`
/// parks a oneshot here while the frontend dialog is up; `resolve_host_key_prompt`
/// (driven by the `ssh_host_key_decision` command) wakes it.
static PENDING_PROMPTS: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const SSH_TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(135);
const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(45);
const SSH_CHANNEL_SETUP_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) async fn await_stage<T, E, F>(
    label: &str,
    timeout: Duration,
    future: F,
) -> Result<T, String>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("{label} timed out after {}s", timeout.as_secs()))?
        .map_err(|e| format!("{label} failed: {e}"))
}

fn pending_prompts() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    PENDING_PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a host-key prompt the frontend answered. Returns false if the prompt
/// id is unknown (already resolved / timed out).
pub fn resolve_host_key_prompt(prompt_id: &str, accept: bool) -> bool {
    let tx = pending_prompts()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(prompt_id));
    match tx {
        Some(tx) => tx.send(accept).is_ok(),
        None => false,
    }
}

/// Monotonic-ish unique prompt id without pulling in a uuid/rng dep: a counter
/// plus the host. Uniqueness only needs to hold among concurrently-open prompts.
fn next_prompt_id(host: &str, port: u16) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("hkp-{host}-{port}-{n}")
}

async fn await_host_key_decision(receiver: oneshot::Receiver<bool>, timeout: Duration) -> bool {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(decision)) => decision,
        Ok(Err(_)) | Err(_) => false,
    }
}

/// russh client handler. Host-key verification happens in `check_server_key`.
pub struct ClientHandler {
    host: String,
    port: u16,
    policy: HostKeyPolicy,
    /// Used to emit a HostKeyPrompt to the frontend when policy is Prompt.
    on_event: IpcChannel<PtyEvent>,
}

impl ClientHandler {
    /// Ask the frontend to confirm a fingerprint, blocking until it replies (or
    /// the channel/dialog goes away, treated as "reject"). `reason` tells the
    /// dialog whether this is genuine first-use (`"unknown"`) or a host already
    /// in known_hosts whose key we couldn't confirm (`"unverifiable"`), so the
    /// copy can differ and never falsely claim the key will be saved.
    async fn prompt_user(&self, key: &PublicKey, reason: &str) -> bool {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = key.algorithm().to_string();
        let prompt_id = next_prompt_id(&self.host, self.port);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut m) = pending_prompts().lock() {
            m.insert(prompt_id.clone(), tx);
        } else {
            return false;
        }
        // Guard removes the registry entry on every exit path — normal return,
        // channel-send failure, sender-dropped, AND if this future is cancelled
        // mid-await (e.g. the connect attempt is dropped). Prevents a leaked
        // oneshot sender lingering in PENDING_PROMPTS.
        struct PromptGuard<'a>(&'a str);
        impl Drop for PromptGuard<'_> {
            fn drop(&mut self) {
                let _ = pending_prompts().lock().map(|mut m| m.remove(self.0));
            }
        }
        let _guard = PromptGuard(&prompt_id);

        let sent = self.on_event.send(PtyEvent::HostKeyPrompt {
            prompt_id: prompt_id.clone(),
            host: self.host.clone(),
            port: self.port,
            fingerprint,
            key_type,
            reason: reason.to_string(),
        });
        if sent.is_err() {
            return false; // frontend channel gone; guard cleans up
        }
        // A lost frontend event must not park ssh_open forever. Sender drop and
        // timeout both fail closed; PromptGuard removes the registry entry.
        await_host_key_decision(rx, HOST_KEY_PROMPT_TIMEOUT).await
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        match known_hosts::verify(&self.host, self.port, key) {
            Verdict::Match => Ok(true),
            Verdict::Mismatch => {
                log::warn!(
                    "ssh host-key MISMATCH for {}:{} — refusing (possible MITM)",
                    self.host,
                    self.port
                );
                Ok(false)
            }
            Verdict::Revoked => {
                log::warn!(
                    "ssh host key for {}:{} is explicitly REVOKED — refusing",
                    self.host,
                    self.port
                );
                Ok(false)
            }
            Verdict::Unknown => match self.policy {
                HostKeyPolicy::AcceptUnknown => {
                    if let Err(e) = known_hosts::remember(&self.host, self.port, key) {
                        log::warn!("ssh: failed to persist new host key: {e}");
                    }
                    Ok(true)
                }
                HostKeyPolicy::Prompt => {
                    if self.prompt_user(key, "unknown").await {
                        // User confirmed first-use → trust and persist.
                        if let Err(e) = known_hosts::remember(&self.host, self.port, key) {
                            log::warn!("ssh: failed to persist new host key: {e}");
                        }
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                }
            },
            Verdict::Unverifiable => {
                // known_hosts has hashed/wildcard entries we can't match; this
                // could be a rotated key on a known host. Accept only after an
                // explicit decision, and deliberately do NOT remember it —
                // persisting would mask a real mismatch on the next connection.
                match self.policy {
                    HostKeyPolicy::AcceptUnknown => {
                        log::warn!(
                            "ssh host {}:{} not verifiable against hashed/wildcard known_hosts — \
                             accepting without persisting (rotated-key risk)",
                            self.host,
                            self.port
                        );
                        Ok(true)
                    }
                    HostKeyPolicy::Prompt => {
                        // Prompt, but never persist on Unverifiable. The
                        // "unverifiable" reason makes the dialog say so instead
                        // of falsely promising to save the key.
                        Ok(self.prompt_user(key, "unverifiable").await)
                    }
                }
            }
        }
    }
}

/// Remote shell-integration bootstrap (OSC 7 + OSC 133 hooks for bash/zsh).
/// Staged into a private remote temp file over an exec channel, then sourced
/// by one SHORT line typed into the interactive shell (see
/// `stage_remote_bootstrap` for why it must never be sent inline).
const REMOTE_INTEGRATION: &str = include_str!("scripts/remote-integration.sh");
const AGENT_HOOK_HELPER: &str = include_str!("../agent/scripts/agent-hook.sh");

/// Bound on queued input messages (keystrokes/resizes) waiting for the pump.
/// Far above human input rate; on overflow we drop rather than buffer forever.
const INPUT_QUEUE_CAP: usize = 1024;
const SSH_DISCONNECTED_EXIT_CODE: i32 = -2;

/// Parameters to open an SSH session.
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub auth: AuthOptions,
    pub policy: HostKeyPolicy,
    pub cols: u16,
    pub rows: u16,
    /// Absolute remote directory restored after the interactive shell starts.
    /// A missing/unavailable directory degrades to the login home.
    pub initial_cwd: Option<String>,
    /// Inject remote shell integration so the remote shell emits OSC 7 / OSC
    /// 133 (cwd + command boundaries) and wraps agents to emit OSC 777
    /// lifecycle events. Default-on (see ssh_open) — degrades silently on
    /// unsupported shells.
    pub inject_shell_integration: bool,
    /// Logical session id, substituted into the remote integration script so
    /// the OSC 777 agent events it emits carry a `session` field the frontend
    /// will accept (parseAgentLifecycleOsc drops mismatched sessions). Empty
    /// when unknown (reopen-less path); the agent wrappers then self-disable.
    pub session_id: String,
}

/// A connected, authenticated SSH session with a live shell channel.
/// Owns the input sender (frontend keystrokes → channel) and resize/close
/// controls. The `Handle` stays alive so an SFTP channel can be opened on the
/// same connection (Phase 3).
pub struct SshSession {
    handle: Handle<ClientHandler>,
    input_tx: mpsc::Sender<InputMsg>,
    /// Lazily-opened SFTP subsystem on a SEPARATE channel of this connection.
    /// Guarded by an async mutex so concurrent fs commands serialize cleanly.
    sftp: tokio::sync::Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>,
}

enum InputMsg {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

fn send_connection_status(on_event: &IpcChannel<PtyEvent>, phase: &str) {
    let _ = on_event.send(PtyEvent::ConnectionStatus {
        phase: phase.to_string(),
    });
}

impl SshSession {
    /// Connect, authenticate, open a shell PTY, and start pumping output into
    /// `on_event`. Returns once the shell is live; output streaming continues
    /// on a background tokio task.
    pub async fn open(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
    ) -> Result<SshSession, String> {
        send_connection_status(&on_event, "connecting");
        let config = Arc::new(client::Config {
            // Keep long-lived terminals alive; max>0 so a single missed reply
            // doesn't drop the session (Tabby hit KeepaliveTimeout otherwise).
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });

        let handler = ClientHandler {
            host: params.host.clone(),
            port: params.port,
            policy: params.policy,
            // Cloned so the handler can emit a HostKeyPrompt during connect;
            // the original still feeds the output pump below.
            on_event: on_event.clone(),
        };

        // Bound DNS/TCP establishment separately from the SSH handshake: the
        // latter may legitimately wait for the user's host-key decision.
        let socket = tokio::time::timeout(
            SSH_TCP_CONNECT_TIMEOUT,
            tokio::net::TcpStream::connect((params.host.as_str(), params.port)),
        )
        .await
        .map_err(|_| {
            format!(
                "connect {}:{} timed out after {}s",
                params.host,
                params.port,
                SSH_TCP_CONNECT_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("connect {}:{} failed: {e}", params.host, params.port))?;
        if let Err(e) = socket.set_nodelay(true) {
            log::debug!("ssh: set TCP_NODELAY failed: {e}");
        }
        send_connection_status(&on_event, "handshaking");
        let mut handle = await_stage(
            &format!("SSH handshake {}:{}", params.host, params.port),
            SSH_HANDSHAKE_TIMEOUT,
            client::connect_stream(config, socket, handler),
        )
        .await?;

        send_connection_status(&on_event, "authenticating");
        await_stage(
            "SSH authentication",
            SSH_AUTH_TIMEOUT,
            auth::authenticate(&mut handle, &params.auth),
        )
        .await?;

        send_connection_status(&on_event, "openingShell");
        let mut channel = await_stage(
            "open session channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request PTY",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_pty(
                false,
                "xterm-256color",
                params.cols as u32,
                params.rows as u32,
                0,
                0,
                &[],
            ),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }
        if let Err(error) = await_stage(
            "request shell",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_shell(true),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }

        // Stage shell integration and the saved cwd into one private bootstrap,
        // then type only a SHORT source line into the interactive shell. This
        // keeps long/unicode paths and the integration payload out of the tty's
        // canonical input limit. If staging is unavailable, a normal-sized cwd
        // still falls back to a directly typed, safely quoted `cd` command.
        if params.inject_shell_integration || params.initial_cwd.is_some() {
            match stage_remote_bootstrap(
                &handle,
                &params.session_id,
                params.inject_shell_integration,
                params.initial_cwd.as_deref(),
            )
            .await
            {
                Ok(path) => {
                    let line = integration_source_line(&path);
                    if let Err(e) = channel.data(line.as_bytes()).await {
                        log::debug!("ssh bootstrap inject failed: {e}");
                    }
                }
                Err(e) => {
                    log::debug!("ssh bootstrap staging failed: {e}");
                    if let Some(cwd) = params.initial_cwd.as_deref() {
                        let line = initial_cwd_fallback_line(cwd);
                        if let Err(write_error) = channel.data(line.as_bytes()).await {
                            log::debug!("ssh initial cwd fallback failed: {write_error}");
                        }
                    }
                }
            }
        }

        // Bounded so a fast typist / large paste on a slow link can't grow the
        // queue without limit while the pump is parked on `channel.data().await`.
        // 1024 keystroke/resize messages is far beyond human input rate; on
        // overflow `write` drops with an error rather than buffering unboundedly.
        let (input_tx, mut input_rx) = mpsc::channel::<InputMsg>(INPUT_QUEUE_CAP);
        send_connection_status(&on_event, "ready");

        // Pump: remote output → PtyEvent::Data; frontend input → channel.
        //
        // Unlike the local PTY (which has a reader thread feeding a shared
        // buffer drained by a 16ms flusher, hence its MAX_PENDING cap), the SSH
        // path has NO intermediate accumulator: each `ChannelMsg::Data` is
        // encoded and sent immediately, and russh's own per-channel flow-control
        // window bounds how much the server can have in flight. `on_event.send`
        // is non-blocking. So there is no unbounded buffer to cap here — don't
        // "add MAX_PENDING" without first reintroducing a buffer that needs it.
        tauri::async_runtime::spawn(async move {
            // An interactive SSH channel can disappear without sending an
            // ExitStatus when the network or server dies. Keep that distinct
            // from a real zero exit so the UI never calls a disconnect clean.
            let mut exit_code: Option<i32> = None;
            // Stop forwarding frontend keystrokes once the remote shell is
            // exiting — otherwise a passive disconnect races with queued input
            // and the server may echo a burst of characters before the channel
            // closes. Output from channel.wait() keeps draining until Eof.
            let mut accepting_input = true;
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        let Some(msg) = msg else { break };
                        match msg {
                            ChannelMsg::Data { ref data } => {
                                let ev = PtyEvent::Data { data: B64.encode(data) };
                                if on_event.send(ev).is_err() { break; }
                            }
                            // stderr (ext=1) is interleaved into the same stream;
                            // a terminal shows both on one screen.
                            ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                                let ev = PtyEvent::Data { data: B64.encode(data) };
                                if on_event.send(ev).is_err() { break; }
                            }
                            ChannelMsg::ExitStatus { exit_status } => {
                                exit_code = Some(exit_status as i32);
                                accepting_input = false;
                            }
                            ChannelMsg::ExitSignal { .. } => {
                                // Killed by a signal rather than a clean exit.
                                exit_code = Some(-1);
                                accepting_input = false;
                            }
                            ChannelMsg::Eof | ChannelMsg::Close => break,
                            _ => {}
                        }
                    }
                    input = input_rx.recv(), if accepting_input => {
                        match input {
                            Some(InputMsg::Data(bytes)) => {
                                if channel.data(&bytes[..]).await.is_err() {
                                    accepting_input = false;
                                }
                            }
                            Some(InputMsg::Resize { cols, rows }) => {
                                let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                            }
                            Some(InputMsg::Close) | None => {
                                let _ = channel.eof().await;
                                break;
                            }
                        }
                    }
                }
            }
            let _ = on_event.send(PtyEvent::Exit {
                code: exit_code.unwrap_or(SSH_DISCONNECTED_EXIT_CODE),
            });
        });

        Ok(SshSession {
            handle,
            input_tx,
            sftp: tokio::sync::Mutex::new(None),
        })
    }

    /// Get (opening on first use) the SFTP session for this connection. The
    /// SFTP subsystem runs on its own channel, separate from the shell.
    pub async fn sftp(&self) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = await_stage(
            "open SFTP channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        // If the subsystem request fails (server has no sftp-server / Subsystem
        // sftp disabled), `channel` is still a plain russh Channel — which has
        // NO Drop-side CLOSE (see the exec() cleanup contract below), so simply
        // returning here would leak the just-opened channel slot on the live
        // connection. Close it explicitly first, mirroring exec(). On success
        // the channel is consumed by into_stream() (whose ChannelStream self-
        // closes on drop), so only the request-failure path needs this.
        if let Err(e) = await_stage(
            "request SFTP subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(e);
        }
        let session = await_stage(
            "initialize SFTP",
            SSH_CHANNEL_SETUP_TIMEOUT,
            russh_sftp::client::SftpSession::new(channel.into_stream()),
        )
        .await?;
        let arc = std::sync::Arc::new(session);
        *guard = Some(arc.clone());
        Ok(arc)
    }

    /// Read a remote directory a page at a time, enforcing limits before pages
    /// accumulate into one unbounded high-level `ReadDir`. A dedicated SFTP
    /// channel keeps cleanup local: every success, timeout, protocol error, and
    /// limit rejection explicitly closes both the directory handle and session.
    pub async fn read_dir_bounded(
        &self,
        path: &str,
        max_entries: usize,
        max_name_bytes: usize,
        timeout: Duration,
    ) -> Result<Vec<russh_sftp::protocol::File>, String> {
        use russh_sftp::client::error::Error as SftpError;
        use russh_sftp::protocol::StatusCode;

        let channel = await_stage(
            "open directory SFTP channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request directory SFTP subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }

        let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
        raw.set_timeout(15);
        if let Err(error) = await_stage(
            "initialize directory SFTP",
            SSH_CHANNEL_SETUP_TIMEOUT,
            raw.init(),
        )
        .await
        {
            let _ = raw.close_session();
            return Err(error);
        }
        let handle = match await_stage(
            "open remote directory",
            SSH_CHANNEL_SETUP_TIMEOUT,
            raw.opendir(path),
        )
        .await
        {
            Ok(handle) => handle.handle,
            Err(error) => {
                let _ = raw.close_session();
                return Err(error);
            }
        };

        let deadline = tokio::time::Instant::now() + timeout;
        let mut files = Vec::new();
        let mut name_bytes = 0usize;
        let result = loop {
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                break Err(format!(
                    "read remote directory timed out after {}s",
                    timeout.as_secs()
                ));
            };
            let page = match tokio::time::timeout(remaining, raw.readdir(handle.clone())).await {
                Ok(Ok(page)) => page,
                Ok(Err(SftpError::Status(status))) if status.status_code == StatusCode::Eof => {
                    break Ok(files);
                }
                Ok(Err(error)) => break Err(format!("read remote directory failed: {error}")),
                Err(_) => {
                    break Err(format!(
                        "read remote directory timed out after {}s",
                        timeout.as_secs()
                    ));
                }
            };

            let mut limit_error = None;
            for file in page.files {
                if files.len() >= max_entries {
                    limit_error = Some(format!("remote directory exceeds {max_entries} entries"));
                    break;
                }
                let Some(next_name_bytes) = name_bytes
                    .checked_add(file.filename.len())
                    .and_then(|value| value.checked_add(file.longname.len()))
                else {
                    limit_error = Some("remote directory name size overflow".to_string());
                    break;
                };
                if next_name_bytes > max_name_bytes {
                    limit_error = Some(format!(
                        "remote directory names exceed {max_name_bytes} bytes"
                    ));
                    break;
                }
                name_bytes = next_name_bytes;
                files.push(file);
            }
            if let Some(error) = limit_error {
                break Err(error);
            }
        };

        let _ = tokio::time::timeout(Duration::from_secs(2), raw.close(handle)).await;
        let _ = raw.close_session();
        result
    }

    // These run on the sync Tauri command thread, so they use `try_send`
    // (non-blocking). A full queue means the remote is far behind; dropping a
    // keystroke is the same backpressure posture the local PTY takes on output
    // overflow, and is preferable to blocking the UI thread.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.input_tx
            .try_send(InputMsg::Data(data.to_vec()))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => "ssh input queue full".to_string(),
                mpsc::error::TrySendError::Closed(_) => "ssh session closed".to_string(),
            })
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.input_tx
            .try_send(InputMsg::Resize { cols, rows })
            .map_err(|_| "ssh session closed or busy".to_string())
    }

    /// Signal the pump task to close the channel. Returns Err if the pump task
    /// is already gone (channel closed) — callers that surface close errors
    /// (Session::kill) can then report it, matching the local-PTY path. The
    /// connection `Handle` itself is dropped when the SshSession is dropped.
    pub fn close(&self) -> Result<(), String> {
        self.input_tx
            .try_send(InputMsg::Close)
            .map_err(|_| "ssh session already closed".to_string())
    }

    /// Run a one-shot command on the remote host over a fresh exec channel on
    /// this same connection, collect stdout (and interleaved stderr) up to
    /// `max_bytes`, and return it once the channel closes.
    ///
    /// Runs on its own SSH channel, so it never blocks the interactive shell
    /// channel (russh multiplexes channels over one TCP connection). The shell
    /// keeps streaming while an exec is in flight.
    ///
    /// Errors surface as strings; callers (e.g. remote git status) degrade to
    /// a "remote git unavailable" message instead of crashing the session.
    pub async fn exec(&self, command: &str, max_bytes: usize) -> Result<String, String> {
        exec_on(
            &self.handle,
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            None,
        )
        .await
    }

    /// Execute a one-shot inspection command that can be stopped when its UI
    /// request is superseded. `exec_on` still owns channel teardown, so
    /// cancellation sends CHANNEL_CLOSE instead of merely dropping the future
    /// and leaving the remote `find`/`grep`/`git diff` process alive.
    pub async fn exec_cancellable(
        &self,
        command: &str,
        max_bytes: usize,
        cancelled: Arc<AtomicBool>,
    ) -> Result<String, String> {
        exec_on(
            &self.handle,
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            Some(cancelled.as_ref()),
        )
        .await
    }

    /// Execute a probe where a non-zero status is part of the caller's state
    /// machine rather than a transport failure (for example, Git with no
    /// upstream). All other SSH commands should use `exec`.
    pub async fn exec_allow_nonzero(
        &self,
        command: &str,
        max_bytes: usize,
    ) -> Result<String, String> {
        exec_on(
            &self.handle,
            command,
            max_bytes,
            Duration::from_secs(15),
            true,
            None,
        )
        .await
    }
}

fn exec_status_error(
    exit_status: Option<u32>,
    exit_signal: Option<&str>,
    stderr: &[u8],
) -> Option<String> {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if let Some(signal) = exit_signal {
        return Some(if stderr.is_empty() {
            format!("remote command terminated by signal {signal}")
        } else {
            stderr
        });
    }
    match exit_status {
        Some(0) | None => None,
        Some(status) => Some(if stderr.is_empty() {
            format!("remote command exited with status {status}")
        } else {
            stderr
        }),
    }
}

fn stderr_only_is_error(allow_nonzero: bool, exit_status: Option<u32>) -> bool {
    !allow_nonzero || exit_status.is_none() || exit_status == Some(0)
}

/// `SshSession::exec`, as a free function so it can also run during
/// `SshSession::open` (integration staging) before the session is constructed.
async fn exec_on(
    handle: &Handle<ClientHandler>,
    command: &str,
    max_bytes: usize,
    timeout: Duration,
    allow_nonzero: bool,
    cancelled: Option<&AtomicBool>,
) -> Result<String, String> {
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        return Err("remote command cancelled".into());
    }
    let mut channel = await_stage(
        "open exec channel",
        SSH_CHANNEL_SETUP_TIMEOUT,
        handle.channel_open_session(),
    )
    .await?;
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        let _ = channel.close().await;
        return Err("remote command cancelled".into());
    }
    if let Err(error) = await_stage(
        "start remote command",
        SSH_CHANNEL_SETUP_TIMEOUT,
        channel.exec(true, command),
    )
    .await
    {
        let _ = channel.close().await;
        return Err(error);
    }

    let cancellation = wait_for_exec_cancel(cancelled);
    tokio::pin!(cancellation);

    let mut out: Vec<u8> = Vec::new();
    let mut stderr_buf: Vec<u8> = Vec::new();
    let mut exceeded = false;
    let mut timed_out = false;
    let mut was_cancelled = false;
    let mut exit_status: Option<u32> = None;
    let mut exit_signal: Option<String> = None;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            biased;
            _ = &mut cancellation => {
                was_cancelled = true;
                break;
            }
            _ = tokio::time::sleep_until(deadline) => {
                // Break (don't early-return) so we still close the channel
                // below — russh Channel has no Drop-side CLOSE, so dropping
                // it would leave the remote process (e.g. a slow `find /`)
                // running and leak the local channel slot.
                timed_out = true;
                break;
            }
            msg = channel.wait() => {
                let Some(msg) = msg else { break };
                match msg {
                    ChannelMsg::Data { ref data } => {
                        if out.len() + data.len() > max_bytes {
                            // Cap: keep the prefix we already have and stop.
                            let room = max_bytes.saturating_sub(out.len());
                            out.extend_from_slice(&data[..room]);
                            exceeded = true;
                            break;
                        }
                        out.extend_from_slice(data);
                    }
                    ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                        // Capture stderr separately so a git status on a
                        // non-repo dir surfaces a useful error rather than
                        // polluting the parsed stdout.
                        const STDERR_CAP: usize = 4 * 1024;
                        if stderr_buf.len() < STDERR_CAP {
                            let room = STDERR_CAP.saturating_sub(stderr_buf.len());
                            stderr_buf.extend_from_slice(&data[..room.min(data.len())]);
                        }
                    }
                    // ExitStatus may arrive before the final stdout/stderr
                    // packets. Record it and keep draining until EOF/Close.
                    ChannelMsg::ExitStatus { exit_status: status } => {
                        exit_status = Some(status);
                    }
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        exit_signal = Some(format!("{signal_name:?}"));
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        }
    }

    // Always close the channel before returning. On the timeout and
    // cap-exceeded paths the remote process is still running; close() sends
    // CHANNEL_CLOSE so the remote terminates and the local channel slot is
    // released (russh does not do this on drop). On the clean Eof/Close
    // path it's a harmless no-op. Errors here are non-fatal — the command
    // already produced (or failed to produce) its output.
    let _ = channel.close().await;

    if timed_out {
        return Err(format!("exec timed out ({}s)", timeout.as_secs()));
    }
    if was_cancelled {
        return Err("remote command cancelled".into());
    }

    if !allow_nonzero {
        if let Some(error) = exec_status_error(exit_status, exit_signal.as_deref(), &stderr_buf) {
            return Err(error);
        }
    }

    // If we have no stdout but stderr produced something, return stderr so
    // the caller gets a descriptive error (e.g. "fatal: not a git
    // repository"). Trim to keep the toast/message readable.
    if out.is_empty() && !stderr_buf.is_empty() && stderr_only_is_error(allow_nonzero, exit_status)
    {
        let msg = String::from_utf8_lossy(&stderr_buf).trim().to_string();
        return Err(if msg.is_empty() {
            "remote command produced no output".into()
        } else {
            msg
        });
    }

    if exceeded {
        // Hard-cap the output. NOTE: callers can't currently tell truncation
        // from a complete result — `out` carries no marker. Callers that
        // care (remote search) cap well below max_bytes; a marker/flag is a
        // separate contract change, not done here.
        out.truncate(max_bytes);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

async fn wait_for_exec_cancel(cancelled: Option<&AtomicBool>) {
    let Some(cancelled) = cancelled else {
        std::future::pending::<()>().await;
        return;
    };
    while !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Stage the shell-integration bootstrap into a private remote temp file via a
/// one-shot exec channel, returning the remote path to source.
///
/// The script must NEVER be typed into the interactive shell inline: input
/// that arrives before the shell's line editor switches the pty to raw mode
/// sits in the tty's canonical line buffer, which caps a single line at 4096
/// bytes on Linux (1024 on BSD/macOS). The previous one-line
/// `eval "$(printf %s <base64> | base64 -d ...)"` injection was ~11 KB, so the
/// line discipline discarded its tail INCLUDING the terminating newline — the
/// eval never ran, integration was silently lost, and up to 4 KB of base64 was
/// echoed and left pending on the first prompt (junk the user had to Ctrl+C
/// away). The exec channel has no tty, so it carries the payload without any
/// length limit or echo; the shell only ever sees the short source line built
/// by `integration_source_line` (guarded well under the 1024-byte floor).
///
/// `mktemp` creates the file 0600 with O_EXCL under a random name, so a
/// co-tenant on the remote host can neither pre-plant a symlink nor read the
/// staged script. The `sh -c` wrapper keeps the command portable when the
/// login shell is fish/csh. Degrades with Err on servers without
/// mktemp/base64 or with exec disabled; the caller can still attempt a bounded
/// direct cwd restore.
async fn stage_remote_bootstrap(
    handle: &Handle<ClientHandler>,
    session_id: &str,
    inject_shell_integration: bool,
    initial_cwd: Option<&str>,
) -> Result<String, String> {
    let script = render_remote_bootstrap(session_id, inject_shell_integration, initial_cwd);
    let encoded = B64.encode(script.as_bytes());
    let command = integration_stage_command(&encoded);
    let out = exec_on(handle, &command, 4096, Duration::from_secs(5), false, None).await?;
    // Some servers print a banner/MOTD even on exec channels; take the last
    // line that looks like our mktemp path instead of requiring clean output.
    let path = out
        .lines()
        .map(str::trim)
        .rfind(|line| is_safe_remote_path(line));
    match path {
        Some(path) => Ok(path.to_string()),
        None => Err(format!("unexpected staging output: {:?}", out.trim())),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn render_remote_bootstrap(
    session_id: &str,
    inject_shell_integration: bool,
    initial_cwd: Option<&str>,
) -> String {
    let mut script = if inject_shell_integration {
        render_remote_integration(session_id)
    } else {
        String::new()
    };
    if let Some(cwd) = initial_cwd {
        if !script.is_empty() && !script.ends_with('\n') {
            script.push('\n');
        }
        let quoted = shell_quote(cwd);
        script.push_str(&format!(
            "if [ -d {quoted} ]; then\n  cd {quoted} || printf '%s%s\\n' '[tunara] saved remote directory unavailable: ' {quoted}\nelse\n  printf '%s%s\\n' '[tunara] saved remote directory unavailable: ' {quoted}\nfi\n"
        ));
    }
    script
}

fn render_remote_integration(session_id: &str) -> String {
    // Only safe ASCII session ids reach here (logical ids are uuids), but
    // defend against a stray quote breaking the shell by stripping anything
    // outside the id charset before substitution. An empty id disables the
    // agent wrappers via the script's own `[ -n ... ]` guard, leaving
    // OSC 7 / 133 intact.
    let safe_sid: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    REMOTE_INTEGRATION
        .replace("__TUNARA_SESSION_ID__", &safe_sid)
        .replace("__TUNARA_AGENT_HOOK_B64__", &B64.encode(AGENT_HOOK_HELPER))
}

/// One-shot exec command that writes the base64 payload to a fresh `mktemp`
/// file and prints the path (and nothing else) on success. Tries the GNU then
/// BSD base64 decode flag; stderr is discarded so failures stay quiet.
fn integration_stage_command(encoded: &str) -> String {
    format!(
        "sh -c 'f=$(mktemp /tmp/.tunara-si-XXXXXXXXXX) && {{ printf %s {encoded} | base64 --decode 2>/dev/null || printf %s {encoded} | base64 -D 2>/dev/null; }} > \"$f\" && printf %s \"$f\"'"
    )
}

/// The ONLY line typed into the interactive shell: source the staged file,
/// then remove it. Leading space keeps it out of ignorespace-style history;
/// `2>/dev/null` silences non-POSIX shells (fish sources it and hits the
/// bash/zsh guards; csh errors once — same posture as the old inline eval).
/// Must stay far below 1024 bytes, the smallest (BSD) canonical-mode tty line
/// buffer — see `stage_remote_bootstrap` and the regression test below.
fn integration_source_line(path: &str) -> String {
    format!(" . \"{path}\" 2>/dev/null; rm -f \"{path}\"\n")
}

fn initial_cwd_fallback_line(cwd: &str) -> String {
    let line = format!(" cd {}\n", shell_quote(cwd));
    if line.len() < 1_024 {
        line
    } else {
        " printf '%s\\n' '[tunara] saved remote directory path is too long to restore' >&2\n"
            .to_string()
    }
}

/// Accept only the path shape our own stage command can produce — an absolute
/// `/tmp/.tunara-si-*` path in a conservative charset. Anything else (error
/// text, MOTD noise, a hostile multi-line blob) must not reach the shell line.
fn is_safe_remote_path(path: &str) -> bool {
    path.starts_with("/tmp/.tunara-si-")
        && path.len() < 200
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // Signal the pump task to send EOF and stop; dropping the `Handle`
        // (held by this struct) tears down the SSH connection. A polite
        // SSH_MSG_DISCONNECT would need an async context we don't have in
        // Drop — channel EOF + handle drop is sufficient for cleanup. Ignore
        // the result: if the pump is already gone there's nothing to signal.
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: the line typed into the interactive shell must stay far
    /// below the smallest canonical-mode tty line buffer (1024 on BSD/macOS,
    /// 4096 on Linux). The original inline-eval injection was ~11 KB; the
    /// line discipline dropped its tail (newline included), so the eval never
    /// ran and kilobytes of base64 were echoed and left pending at the first
    /// prompt. Payload bytes may only travel over the exec channel.
    #[test]
    fn source_line_fits_every_canonical_tty_buffer() {
        let line = integration_source_line("/tmp/.tunara-si-AbCd012345");
        assert!(
            line.len() < 256,
            "shell line too long: {} bytes",
            line.len()
        );
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1, "must be a single line");
        assert!(
            line.starts_with(' '),
            "leading space keeps it out of history"
        );
    }

    /// The full bootstrap payload (script + base64 expansion) must never leak
    /// into the shell line — only into the exec-channel stage command.
    #[test]
    fn payload_travels_on_the_exec_channel_only() {
        let rendered = render_remote_integration("session-1'$(id)");
        assert!(!rendered.contains("__TUNARA_SESSION_ID__"));
        assert!(!rendered.contains("__TUNARA_AGENT_HOOK_B64__"));
        assert!(rendered.contains("session-1id"));
        assert!(rendered.contains(&B64.encode(AGENT_HOOK_HELPER)[..32]));
        let encoded = B64.encode(rendered.as_bytes());
        assert!(
            encoded.len() > 4096,
            "payload no longer exceeds the canonical limit; if this shrank on \
             purpose the staging design still stands, update this bound"
        );
        let stage = integration_stage_command(&encoded);
        assert!(stage.contains(&encoded));
        let line = integration_source_line("/tmp/.tunara-si-AbCd012345");
        assert!(!line.contains(&encoded[..32]));
    }

    #[test]
    fn remote_bootstrap_restores_a_shell_quoted_unicode_cwd() {
        let cwd = "/srv/可爱动物/it's-here";
        let rendered = render_remote_bootstrap("session-1", true, Some(cwd));
        assert!(rendered.contains("cd '/srv/可爱动物/it'\"'\"'s-here'"));
        assert!(rendered.contains("saved remote directory unavailable"));
        assert!(rendered.contains("session-1"));
        let line = integration_source_line("/tmp/.tunara-si-AbCd012345");
        assert!(!line.contains(cwd), "cwd stays in the staged payload");
    }

    #[test]
    fn cwd_only_bootstrap_does_not_install_shell_integration() {
        let rendered = render_remote_bootstrap("session-1", false, Some("/srv/app"));
        assert!(rendered.contains("cd '/srv/app'"));
        assert!(!rendered.contains("__tunara_"));
    }

    #[test]
    fn initial_cwd_fallback_is_tty_bounded() {
        assert_eq!(
            initial_cwd_fallback_line("/srv/my app"),
            " cd '/srv/my app'\n"
        );
        let long = format!("/{}", "'".repeat(4_096));
        let line = initial_cwd_fallback_line(&long);
        assert!(line.len() < 1_024);
        assert!(line.contains("too long"));
    }

    #[test]
    fn stage_output_path_is_validated() {
        assert!(is_safe_remote_path("/tmp/.tunara-si-aB3xY9_qWe"));
        // Error text, prompts, or anything shell-active must be rejected.
        assert!(!is_safe_remote_path(""));
        assert!(!is_safe_remote_path("mktemp: not found"));
        assert!(!is_safe_remote_path("/tmp/.tunara-si-x; rm -rf ~"));
        assert!(!is_safe_remote_path("/tmp/.tunara-si-x\n/etc/passwd"));
        assert!(!is_safe_remote_path("/tmp/evil-si-abc"));
        assert!(!is_safe_remote_path("/tmp/.tunara-si-x y"));
        assert!(!is_safe_remote_path("/tmp/.tunara-si-x\"$(id)\""));
    }

    #[tokio::test]
    async fn host_key_prompt_accepts_an_explicit_decision() {
        let (tx, rx) = oneshot::channel();
        tx.send(true).expect("decision receiver alive");
        assert!(await_host_key_decision(rx, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn host_key_prompt_timeout_fails_closed() {
        let (_tx, rx) = oneshot::channel();
        assert!(!await_host_key_decision(rx, Duration::from_millis(1)).await);
    }

    #[tokio::test]
    async fn stalled_ssh_stage_returns_a_named_timeout() {
        let result: Result<(), String> = await_stage(
            "test stage",
            Duration::from_millis(1),
            std::future::pending::<Result<(), &str>>(),
        )
        .await;
        assert!(matches!(result, Err(ref e) if e.contains("test stage timed out")));
    }

    #[tokio::test]
    async fn exec_cancellation_waiter_resolves_only_after_token_flips() {
        let cancelled = AtomicBool::new(false);
        let waiter = wait_for_exec_cancel(Some(&cancelled));
        tokio::pin!(waiter);

        assert!(tokio::time::timeout(Duration::from_millis(5), &mut waiter)
            .await
            .is_err());
        cancelled.store(true, Ordering::Release);
        tokio::time::timeout(Duration::from_millis(100), &mut waiter)
            .await
            .expect("cancellation waiter should observe the token");
    }

    #[test]
    fn exec_status_is_not_hidden_by_partial_stdout() {
        assert_eq!(
            exec_status_error(Some(2), None, b"fatal: broken\n"),
            Some("fatal: broken".to_string())
        );
        assert_eq!(
            exec_status_error(Some(7), None, b""),
            Some("remote command exited with status 7".to_string())
        );
        assert_eq!(exec_status_error(Some(0), None, b"warning"), None);
    }

    #[test]
    fn allow_nonzero_does_not_turn_stderr_back_into_a_transport_error() {
        assert!(!stderr_only_is_error(true, Some(1)));
        assert!(stderr_only_is_error(true, Some(0)));
        assert!(stderr_only_is_error(true, None));
        assert!(stderr_only_is_error(false, Some(1)));
    }
}
