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
/// `stage_remote_integration` for why it must never be sent inline).
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

        // Install remote shell integration: stage the bootstrap into a private
        // remote temp file over a separate exec channel, then type only a
        // SHORT ` . file; rm -f file` line into the shell. Both steps degrade
        // silently (same posture as unsupported shells).
        if params.inject_shell_integration {
            match stage_remote_integration(&handle, &params.session_id).await {
                Ok(path) => {
                    let line = integration_source_line(&path);
                    if let Err(e) = channel.data(line.as_bytes()).await {
                        log::debug!("ssh shell-integration inject failed: {e}");
                    }
                }
                Err(e) => log::debug!("ssh shell-integration staging failed: {e}"),
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
            // Stop forwarding frontend keystrokes once the remote shell is
            // exiting — otherwise a passive disconnect races with queued input
            // and the server may echo a burst of characters before the channel
            // closes. Output from channel.wait() keeps draining until Eof.
            let mut accepting_input = true;
            loop {
                tokio::select! {
                    biased;
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
                                accepting_input = false;
                            }
                            ChannelMsg::ExitSignal { .. } => {
                                // Killed by a signal rather than a clean exit.
                                exit_code = -1;
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
        // If the subsystem request fails (server has no sftp-server / Subsystem
        // sftp disabled), `channel` is still a plain russh Channel — which has
        // NO Drop-side CLOSE (see the exec() cleanup contract below), so simply
        // returning here would leak the just-opened channel slot on the live
        // connection. Close it explicitly first, mirroring exec(). On success
        // the channel is consumed by into_stream() (whose ChannelStream self-
        // closes on drop), so only the request-failure path needs this.
        if let Err(e) = channel.request_subsystem(true, "sftp").await {
            let _ = channel.close().await;
            return Err(format!("request sftp subsystem failed: {e}"));
        }
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
        exec_on(&self.handle, command, max_bytes, Duration::from_secs(15)).await
    }
}

/// `SshSession::exec`, as a free function so it can also run during
/// `SshSession::open` (integration staging) before the session is constructed.
async fn exec_on(
    handle: &Handle<ClientHandler>,
    command: &str,
    max_bytes: usize,
    timeout: Duration,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open exec channel failed: {e}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("exec failed: {e}"))?;

    let mut out: Vec<u8> = Vec::new();
    let mut stderr_buf: Vec<u8> = Vec::new();
    let mut exceeded = false;
    let mut timed_out = false;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            biased;
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
                    ChannelMsg::ExitStatus { .. } | ChannelMsg::Eof | ChannelMsg::Close => break,
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

    // If we have no stdout but stderr produced something, return stderr so
    // the caller gets a descriptive error (e.g. "fatal: not a git
    // repository"). Trim to keep the toast/message readable.
    if out.is_empty() && !stderr_buf.is_empty() {
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
/// login shell is fish/csh. Degrades with Err (caller skips injection) on
/// servers without mktemp/base64 or with exec disabled.
async fn stage_remote_integration(
    handle: &Handle<ClientHandler>,
    session_id: &str,
) -> Result<String, String> {
    // Only safe ASCII session ids reach here (logical ids are uuids), but
    // defend against a stray quote breaking the shell by stripping anything
    // outside the id charset before substitution. An empty id disables the
    // agent wrappers via the script's own `[ -n ... ]` guard, leaving
    // OSC 7 / 133 intact.
    let safe_sid: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    let script = REMOTE_INTEGRATION.replace("__TUNARA_SESSION_ID__", &safe_sid);
    let encoded = B64.encode(script.as_bytes());
    let command = integration_stage_command(&encoded);
    let out = exec_on(handle, &command, 4096, Duration::from_secs(5)).await?;
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
/// buffer — see `stage_remote_integration` and the regression test below.
fn integration_source_line(path: &str) -> String {
    format!(" . \"{path}\" 2>/dev/null; rm -f \"{path}\"\n")
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
        let encoded = B64.encode(REMOTE_INTEGRATION.as_bytes());
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
}
