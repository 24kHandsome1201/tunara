// A live SSH connection: one russh `Handle` multiplexing channels.
//
// Phase 1 uses a single interactive shell channel bridged to xterm.js through
// the SAME `PtyEvent` + base64 path the local PTY uses, so the frontend can't
// tell local from remote. The `Handle` is kept alive (later phases open an
// SFTP channel on the same connection).

use std::collections::HashMap;
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

fn pending_prompts() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    PENDING_PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a host-key prompt the frontend answered. Returns false if the prompt
/// id is unknown (already resolved / timed out).
pub fn resolve_host_key_prompt(prompt_id: &str, accept: bool) -> bool {
    let tx = pending_prompts().lock().ok().and_then(|mut m| m.remove(prompt_id));
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
    /// the channel/dialog goes away, treated as "reject").
    async fn prompt_user(&self, key: &PublicKey) -> bool {
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
        });
        if sent.is_err() {
            return false; // frontend channel gone; guard cleans up
        }
        // Ok(accept) → user's choice; Err → sender dropped (shutdown) → refuse.
        rx.await.unwrap_or(false)
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
            Verdict::Unknown => match self.policy {
                HostKeyPolicy::AcceptUnknown => {
                    if let Err(e) = known_hosts::remember(&self.host, self.port, key) {
                        log::warn!("ssh: failed to persist new host key: {e}");
                    }
                    Ok(true)
                }
                HostKeyPolicy::Prompt => {
                    if self.prompt_user(key).await {
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
                        // Prompt, but never persist on Unverifiable.
                        Ok(self.prompt_user(key).await)
                    }
                }
            }
        }
    }
}

/// Remote shell-integration bootstrap (OSC 7 + OSC 133 hooks for bash/zsh).
/// Sent base64-decoded via `eval` so it installs cleanly in one short line.
const REMOTE_INTEGRATION: &str = include_str!("scripts/remote-integration.sh");

/// Bound on queued input messages (keystrokes/resizes) waiting for the pump.
/// Far above human input rate; on overflow we drop rather than buffer forever.
const INPUT_QUEUE_CAP: usize = 1024;

/// Parameters to open an SSH session.
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub auth: AuthOptions,
    pub policy: HostKeyPolicy,
    pub cols: u16,
    pub rows: u16,
    /// Opt-in (Phase 4): inject remote shell integration so the remote shell
    /// emits OSC 7 / OSC 133, giving the host remote cwd + command/agent
    /// detection. Off by default — degrades silently on unsupported shells.
    pub inject_shell_integration: bool,
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

impl SshSession {
    /// Connect, authenticate, open a shell PTY, and start pumping output into
    /// `on_event`. Returns once the shell is live; output streaming continues
    /// on a background tokio task.
    pub async fn open(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
    ) -> Result<SshSession, String> {
        let config = Arc::new(client::Config {
            // Keep long-lived terminals alive; max>0 so a single missed reply
            // doesn't drop the session (Tabby hit KeepaliveTimeout otherwise).
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
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

        let mut handle = client::connect(config, (params.host.as_str(), params.port), handler)
            .await
            .map_err(|e| format!("connect {}:{} failed: {e}", params.host, params.port))?;

        auth::authenticate(&mut handle, &params.auth).await?;

        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("open session channel failed: {e}"))?;
        channel
            .request_pty(
                false,
                "xterm-256color",
                params.cols as u32,
                params.rows as u32,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| format!("request pty failed: {e}"))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("request shell failed: {e}"))?;

        // Phase 4 (opt-in): install remote shell integration. We base64 the
        // bootstrap and `eval` it in one leading-space line (leading space
        // keeps it out of the remote shell's history). Output is suppressed so
        // the only visible trace is the (echoed) command line itself.
        if params.inject_shell_integration {
            let encoded = B64.encode(REMOTE_INTEGRATION.as_bytes());
            // Try GNU then BSD base64 flag; redirect stderr so failures are quiet.
            let line = format!(
                " eval \"$(printf %s {encoded} | base64 --decode 2>/dev/null || printf %s {encoded} | base64 -D 2>/dev/null)\"\n"
            );
            if let Err(e) = channel.data(line.as_bytes()).await {
                log::debug!("ssh shell-integration inject failed: {e}");
            }
        }

        // Bounded so a fast typist / large paste on a slow link can't grow the
        // queue without limit while the pump is parked on `channel.data().await`.
        // 1024 keystroke/resize messages is far beyond human input rate; on
        // overflow `write` drops with an error rather than buffering unboundedly.
        let (input_tx, mut input_rx) = mpsc::channel::<InputMsg>(INPUT_QUEUE_CAP);

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
            let mut exit_code: i32 = 0;
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
                                exit_code = exit_status as i32;
                            }
                            ChannelMsg::ExitSignal { .. } => {
                                // Killed by a signal rather than a clean exit.
                                exit_code = -1;
                            }
                            ChannelMsg::Eof | ChannelMsg::Close => break,
                            _ => {}
                        }
                    }
                    input = input_rx.recv() => {
                        match input {
                            Some(InputMsg::Data(bytes)) => {
                                if channel.data(&bytes[..]).await.is_err() { break; }
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
            let _ = on_event.send(PtyEvent::Exit { code: exit_code });
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
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("open sftp channel failed: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("request sftp subsystem failed: {e}"))?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("sftp init failed: {e}"))?;
        let arc = std::sync::Arc::new(session);
        *guard = Some(arc.clone());
        Ok(arc)
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
