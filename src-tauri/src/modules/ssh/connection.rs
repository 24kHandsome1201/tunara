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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, watch};

use super::auth::{self, AuthOptions};
use super::flow_control::{
    SshBootstrapOutputFilter, SshControl, SshOutputBatch, INPUT_WRITE_CHUNK_BYTES,
    OUTPUT_BATCH_INTERVAL,
};
use super::known_hosts::{self, Verdict};
use super::reverse_forward::ReverseForwardHub;
use crate::modules::pty::output_flow::OutputFlow;
use crate::modules::pty::{HostKeyPersistenceStatus, PtyEvent};

#[derive(serde::Serialize)]
struct PosixRenameRequest<'a> {
    old_path: &'a str,
    new_path: &'a str,
}

fn encode_posix_rename_request(old_path: &str, new_path: &str) -> Result<Vec<u8>, String> {
    russh_sftp::ser::to_bytes(&PosixRenameRequest { old_path, new_path })
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("encode atomic rename request failed: {error}"))
}

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
    /// Test-only delayed TCP proxies terminate locally but forward the real
    /// server key. Accept without touching the user's known_hosts file.
    #[cfg(test)]
    AcceptForTest,
}

/// Pending host-key confirmations, keyed by a per-prompt id. `check_server_key`
/// parks a oneshot here while the frontend dialog is up; `resolve_host_key_prompt`
/// (driven by the `ssh_host_key_decision` command) wakes it.
#[derive(Clone, Copy, Debug)]
pub struct HostKeyDecision {
    accept: bool,
    remember: bool,
}
static PENDING_PROMPTS: OnceLock<Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>> =
    OnceLock::new();
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const SSH_TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(135);
// Keyboard-interactive may wait up to 120s for a user response. Keep the outer
// stage timeout slightly longer so it does not cancel a still-valid challenge.
const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(135);
const SSH_CHANNEL_SETUP_TIMEOUT: Duration = Duration::from_secs(15);

/// GUI clients have no local tty whose termios we can copy. sshd applies only
/// the listed codes and leaves the rest at pty defaults; IUTF8 is the flag
/// that keeps CJK/IME input as UTF-8 instead of 8-bit garbage.
pub(crate) const SSH_PTY_MODES: [(russh::Pty, u32); 1] = [(russh::Pty::IUTF8, 1)];

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

fn pending_prompts() -> &'static Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>> {
    PENDING_PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a host-key prompt the frontend answered. Returns false if the prompt
/// id is unknown (already resolved / timed out).
pub fn resolve_host_key_prompt(prompt_id: &str, accept: bool, remember: bool) -> bool {
    let tx = pending_prompts()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(prompt_id));
    match tx {
        Some(tx) => tx.send(HostKeyDecision { accept, remember }).is_ok(),
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

async fn await_host_key_decision(
    receiver: oneshot::Receiver<HostKeyDecision>,
    timeout: Duration,
) -> HostKeyDecision {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(decision)) => decision,
        Ok(Err(_)) | Err(_) => HostKeyDecision {
            accept: false,
            remember: false,
        },
    }
}

async fn await_host_key_decision_or_cancel(
    receiver: oneshot::Receiver<HostKeyDecision>,
    timeout: Duration,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> HostKeyDecision {
    if *cancel.borrow() {
        return HostKeyDecision {
            accept: false,
            remember: false,
        };
    }
    tokio::select! {
        decision = await_host_key_decision(receiver, timeout) => decision,
        _ = cancel.changed() => HostKeyDecision { accept: false, remember: false },
    }
}

/// russh client handler. Host-key verification happens in `check_server_key`.
pub struct ClientHandler {
    host: String,
    port: u16,
    policy: HostKeyPolicy,
    /// Used to emit a HostKeyPrompt to the frontend when policy is Prompt.
    on_event: IpcChannel<PtyEvent>,
    verified_host_key: Arc<std::sync::Mutex<Option<String>>>,
    /// Attempt-scoped cancellation also reaches russh's detached handshake
    /// task, so a parked host-key prompt cannot retain a route after cancel.
    cancel: tokio::sync::watch::Receiver<bool>,
    /// Connection-level termination signal. Channel EOF alone is not proof
    /// that the multiplexed SSH transport was lost.
    disconnected: tokio::sync::watch::Sender<bool>,
    /// Reverse-forward listeners registered on this multiplexed client.
    reverse_hub: ReverseForwardHub,
}

impl ClientHandler {
    /// Ask the frontend to confirm a fingerprint, blocking until it replies (or
    /// the channel/dialog goes away, treated as "reject"). `reason` tells the
    /// dialog whether this is genuine first-use (`"unknown"`) or a host already
    /// in known_hosts whose key we couldn't confirm (`"unverifiable"`), so the
    /// copy can differ and never falsely claim the key will be saved.
    async fn prompt_user(&self, key: &PublicKey, reason: &str) -> HostKeyDecision {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = key.algorithm().to_string();
        let prompt_id = next_prompt_id(&self.host, self.port);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut m) = pending_prompts().lock() {
            m.insert(prompt_id.clone(), tx);
        } else {
            return HostKeyDecision {
                accept: false,
                remember: false,
            };
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
            return HostKeyDecision {
                accept: false,
                remember: false,
            }; // frontend channel gone
        }
        // A lost frontend event must not park ssh_open forever. Cancellation
        // is selected here because russh performs KEX in a detached task: just
        // dropping connect_stream's caller is not enough to stop this waiter.
        await_host_key_decision_or_cancel(rx, HOST_KEY_PROMPT_TIMEOUT, self.cancel.clone()).await
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        let _ = self.disconnected.send(true);
        async move {
            match reason {
                client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
                client::DisconnectReason::Error(error) => Err(error),
            }
        }
    }

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let accepted = match known_hosts::verify(&self.host, self.port, key) {
            Verdict::Match => Ok::<bool, russh::Error>(true),
            Verdict::Mismatch => {
                log::warn!("ssh host-key mismatch — refusing");
                Ok(false)
            }
            Verdict::Revoked => {
                log::warn!("ssh host key revoked — refusing");
                Ok(false)
            }
            Verdict::Unknown => match self.policy {
                #[cfg(test)]
                HostKeyPolicy::AcceptForTest => Ok(true),
                HostKeyPolicy::AcceptUnknown => {
                    let status = match known_hosts::remember(&self.host, self.port, key) {
                        Ok(()) => HostKeyPersistenceStatus::Saved,
                        Err(known_hosts::RememberError::CommittedButDurabilityUnknown(_)) => {
                            log::warn!("ssh host-key saved but directory durability is unknown");
                            HostKeyPersistenceStatus::CommittedButDurabilityUnknown
                        }
                        Err(known_hosts::RememberError::TrustChanged)
                        | Err(known_hosts::RememberError::PreCommitFailure(_)) => {
                            log::warn!("ssh host-key persistence failed before commit");
                            return Ok(false);
                        }
                    };
                    let _ = self.on_event.send(PtyEvent::HostKeyPersistence {
                        host: self.host.clone(),
                        port: self.port,
                        status,
                    });
                    Ok(true)
                }
                HostKeyPolicy::Prompt => {
                    let decision = self.prompt_user(key, "unknown").await;
                    if !decision.accept {
                        return Ok(false);
                    }
                    let persistence = if decision.remember {
                        match known_hosts::remember(&self.host, self.port, key) {
                            Ok(()) => HostKeyPersistenceStatus::Saved,
                            Err(known_hosts::RememberError::TrustChanged) => {
                                log::warn!(
                                    "ssh: known_hosts trust changed while prompting — refusing"
                                );
                                return Ok(false);
                            }
                            Err(known_hosts::RememberError::PreCommitFailure(_)) => {
                                log::warn!("ssh host-key persistence failed");
                                HostKeyPersistenceStatus::PreCommitFailure
                            }
                            Err(known_hosts::RememberError::CommittedButDurabilityUnknown(_)) => {
                                log::warn!(
                                    "ssh host-key saved but directory durability is unknown"
                                );
                                HostKeyPersistenceStatus::CommittedButDurabilityUnknown
                            }
                        }
                    } else {
                        if !known_hosts::confirm_session_only(&self.host, self.port, key) {
                            log::warn!("ssh: known_hosts trust changed while prompting — refusing");
                            return Ok(false);
                        }
                        HostKeyPersistenceStatus::SessionOnly
                    };
                    let _ = self.on_event.send(PtyEvent::HostKeyPersistence {
                        host: self.host.clone(),
                        port: self.port,
                        status: persistence,
                    });
                    Ok(true)
                }
            },
            Verdict::Unverifiable => {
                log::warn!("ssh host key cannot be safely verified — refusing");
                Ok(false)
            }
        }?;
        if accepted {
            let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
            *self
                .verified_host_key
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(fingerprint);
        }
        Ok(accepted)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(accept) = self
            .reverse_hub
            .try_accept(connected_address, connected_port)
        else {
            return Ok(());
        };
        tokio::spawn(async move {
            if let Err(error) = accept.relay(channel).await {
                log::debug!("ssh reverse forward relay ended: {error}");
            }
        });
        Ok(())
    }
}

/// Remote shell-integration bootstrap (OSC 7 + OSC 133 hooks for bash/zsh).
/// Staged into a private remote temp file over an exec channel, then sourced
/// by one SHORT line typed into the interactive shell (see
/// `stage_remote_bootstrap` for why it must never be sent inline).
const REMOTE_INTEGRATION: &str = include_str!("scripts/remote-integration.sh");
const AGENT_HOOK_HELPER: &str = include_str!("../agent/scripts/agent-hook.sh");

const SSH_DISCONNECTED_EXIT_CODE: i32 = -2;
const SSH_FINAL_OUTPUT_FLUSH_TIMEOUT: Duration = Duration::from_millis(250);
const SSH_TRANSPORT_LOST_REASON: &str = "transportClosed";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PumpEnd {
    RemoteExit,
    LocalClose,
    ChannelEnded,
    TransportLost,
}

fn classify_pump_end(
    exit_code: Option<i32>,
    local_close: bool,
    _channel_ended: bool,
    transport_disconnected: bool,
) -> PumpEnd {
    if exit_code.is_some() {
        PumpEnd::RemoteExit
    } else if local_close {
        PumpEnd::LocalClose
    } else if transport_disconnected {
        PumpEnd::TransportLost
    } else {
        PumpEnd::ChannelEnded
    }
}

fn direct_tcpip_relay_complete(local_closed: bool, remote_closed: bool) -> bool {
    local_closed && remote_closed
}

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
    pub transport_generation: String,
    pub hop_role: String,
    /// Secret-free jump identity used to decide whether two shells can share a TCP transport.
    pub jump_endpoint: Option<(String, u16, String)>,
}

/// A connected, authenticated SSH session with a live shell channel.
/// Owns the input sender (frontend keystrokes → channel) and resize/close
/// controls. The `Handle` stays alive so an SFTP channel can be opened on the
/// same connection (Phase 3).
pub struct SshSession {
    handle: Arc<Handle<ClientHandler>>,
    #[allow(dead_code)] // owns the duplicated socket for the transport lifetime
    transport_abort: Arc<std::net::TcpStream>,
    /// Retains the authenticated outer transport for a ProxyJump session. The
    /// target Handle's stream is a direct-tcpip channel owned by this handle,
    /// so dropping it would tear down the nested connection.
    _jump_handle: Option<Arc<Handle<ClientHandler>>>,
    control: Arc<SshControl>,
    output_flow: Arc<OutputFlow>,
    transport_lost: Arc<AtomicBool>,
    disconnected: watch::Receiver<bool>,
    host: String,
    port: u16,
    user: String,
    verified_host_key: String,
    logical_session_id: String,
    identity_file: Option<String>,
    jump_endpoint: Option<(String, u16, String)>,
    /// Lazily-opened SFTP subsystem on a SEPARATE channel of this connection.
    /// Guarded by an async mutex so concurrent fs commands serialize cleanly.
    /// Shared across multiplexed shells on the same TCP transport.
    sftp:
        std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>>,
    reverse_hub: ReverseForwardHub,
}

/// Cloneable pieces of an authenticated SSH TCP transport. A second interactive
/// shell opens another session channel on these Arcs instead of reconnecting.
#[derive(Clone)]
pub struct SharedSshTransport {
    handle: Arc<Handle<ClientHandler>>,
    transport_abort: Arc<std::net::TcpStream>,
    jump_handle: Option<Arc<Handle<ClientHandler>>>,
    sftp:
        std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>>,
    transport_lost: Arc<AtomicBool>,
    disconnected: watch::Receiver<bool>,
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    #[allow(dead_code)]
    user: String,
    verified_host_key: String,
    #[allow(dead_code)]
    identity_file: Option<String>,
    jump_endpoint: Option<(String, u16, String)>,
    reverse_hub: ReverseForwardHub,
}

async fn close_forward_channel_owned(channel: russh::Channel<russh::client::Msg>) {
    // A channel may be multiplexed with other interactive shells. Never
    // tear down the shared TCP transport merely because this channel's close
    // is slow; dropping the channel after the bounded close attempt cancels
    // only this open/relay.
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
}

struct ForwardChannel {
    channel: Option<russh::Channel<russh::client::Msg>>,
}

impl ForwardChannel {
    fn new(channel: russh::Channel<russh::client::Msg>) -> Self {
        Self {
            channel: Some(channel),
        }
    }

    fn into_inner(mut self) -> russh::Channel<russh::client::Msg> {
        self.channel.take().expect("forward channel is present")
    }

    async fn finish(mut self) {
        if let Some(channel) = self.channel.take() {
            close_forward_channel_owned(channel).await;
        }
    }
}

impl std::ops::Deref for ForwardChannel {
    type Target = russh::Channel<russh::client::Msg>;

    fn deref(&self) -> &Self::Target {
        self.channel.as_ref().expect("forward channel is present")
    }
}

impl std::ops::DerefMut for ForwardChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.channel.as_mut().expect("forward channel is present")
    }
}

impl Drop for ForwardChannel {
    fn drop(&mut self) {
        let Some(channel) = self.channel.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(close_forward_channel_owned(channel));
        }
    }
}

async fn await_pending_forward_open<C, F, S>(
    open: F,
    cancelled: &mut watch::Receiver<bool>,
    session_closed: S,
    timeout: Duration,
) -> Result<C, String>
where
    C: Send + 'static,
    F: Future<Output = Result<C, String>> + Send + 'static,
    S: Future<Output = ()>,
{
    let mut worker = tokio::spawn(open);
    tokio::select! {
        biased;
        _ = cancelled.changed() => {
            // Dropping the JoinHandle detaches this single open. Its eventual
            // channel value is dropped (and therefore channel-closed) without
            // touching any other channel on the multiplexed transport.
            Err("local forward cancelled".into())
        },
        _ = session_closed => Err("SSH session closed".into()),
        _ = tokio::time::sleep(timeout) => Err("SSH port forward channel timed out".into()),
        result = &mut worker => result
            .map_err(|error| format!("SSH forward channel task failed: {error}"))?,
    }
}

async fn await_pending_shell_open(
    handle: Arc<Handle<ClientHandler>>,
    cancelled: &mut watch::Receiver<bool>,
    disconnected: &mut watch::Receiver<bool>,
) -> Result<ForwardChannel, String> {
    if *cancelled.borrow() {
        return Err("SSH connection canceled".into());
    }
    if *disconnected.borrow() {
        return Err("SSH session closed".into());
    }
    let mut worker = tokio::spawn(async move {
        handle
            .channel_open_session()
            .await
            .map(ForwardChannel::new)
            .map_err(|error| format!("open session channel failed: {error}"))
    });
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("SSH connection canceled".into()),
        _ = disconnected.changed() => Err("SSH session closed".into()),
        _ = tokio::time::sleep(SSH_CHANNEL_SETUP_TIMEOUT) => Err(format!(
            "open session channel timed out after {}s",
            SSH_CHANNEL_SETUP_TIMEOUT.as_secs()
        )),
        result = &mut worker => result
            .map_err(|error| format!("open session channel task failed: {error}"))?,
    }
}

async fn await_pending_exec_open(
    handle: Arc<Handle<ClientHandler>>,
    cancelled: Option<&AtomicBool>,
) -> Result<ForwardChannel, String> {
    let mut worker = tokio::spawn(async move {
        handle
            .channel_open_session()
            .await
            .map(ForwardChannel::new)
            .map_err(|error| format!("open exec channel failed: {error}"))
    });
    let cancellation = wait_for_exec_cancel(cancelled);
    tokio::pin!(cancellation);
    tokio::select! {
        biased;
        _ = &mut cancellation => Err("remote command cancelled".into()),
        _ = tokio::time::sleep(SSH_CHANNEL_SETUP_TIMEOUT) => Err(format!(
            "open exec channel timed out after {}s",
            SSH_CHANNEL_SETUP_TIMEOUT.as_secs()
        )),
        result = &mut worker => result
            .map_err(|error| format!("open exec channel task failed: {error}"))?,
    }
}

async fn await_shell_setup_stage<T, E, F>(
    label: &str,
    cancelled: &mut watch::Receiver<bool>,
    disconnected: &mut watch::Receiver<bool>,
    future: F,
) -> Result<T, String>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    if *cancelled.borrow() {
        return Err("SSH connection canceled".into());
    }
    if *disconnected.borrow() {
        return Err("SSH session closed".into());
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("SSH connection canceled".into()),
        _ = disconnected.changed() => Err("SSH session closed".into()),
        result = await_stage(label, SSH_CHANNEL_SETUP_TIMEOUT, future) => result,
    }
}

#[derive(Debug)]
pub enum RoutedOpenError {
    Jump(String),
    Target(String),
}

async fn connect_authenticated_stream<S>(
    params: &ConnectParams,
    on_event: IpcChannel<PtyEvent>,
    cancel: tokio::sync::watch::Receiver<bool>,
    stream: S,
) -> Result<
    (
        Handle<ClientHandler>,
        watch::Receiver<bool>,
        Arc<std::sync::Mutex<Option<String>>>,
        ReverseForwardHub,
    ),
    String,
>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let verified_host_key = Arc::new(std::sync::Mutex::new(None));
    let (disconnected, disconnected_rx) = watch::channel(false);
    let reverse_hub = ReverseForwardHub::default();
    let handler = ClientHandler {
        host: params.host.clone(),
        port: params.port,
        policy: params.policy,
        on_event: on_event.clone(),
        verified_host_key: Arc::clone(&verified_host_key),
        cancel,
        disconnected,
        reverse_hub: reverse_hub.clone(),
    };
    send_connection_status(&on_event, "handshaking");
    let mut handle = await_stage(
        &format!("SSH handshake {}:{}", params.host, params.port),
        SSH_HANDSHAKE_TIMEOUT,
        client::connect_stream(config, stream, handler),
    )
    .await?;
    send_connection_status(&on_event, "authenticating");
    await_stage(
        "SSH authentication",
        SSH_AUTH_TIMEOUT,
        auth::authenticate(
            &mut handle,
            &params.auth,
            on_event,
            crate::modules::pty::KeyboardInteractiveOrigin {
                user: params.auth.user.clone(),
                host: params.host.clone(),
                port: params.port,
                logical_session_id: params.session_id.clone(),
                hop_role: params.hop_role.clone(),
                transport_generation: params.transport_generation.clone(),
            },
        ),
    )
    .await?;
    Ok((handle, disconnected_rx, verified_host_key, reverse_hub))
}

async fn connect_direct_authenticated(
    params: &ConnectParams,
    on_event: IpcChannel<PtyEvent>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<
    (
        Handle<ClientHandler>,
        watch::Receiver<bool>,
        Arc<std::sync::Mutex<Option<String>>>,
        Arc<std::net::TcpStream>,
        ReverseForwardHub,
    ),
    String,
> {
    send_connection_status(&on_event, "connecting");
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
    let socket = socket
        .into_std()
        .map_err(|e| format!("prepare SSH transport abort failed: {e}"))?;
    let transport_abort = Arc::new(
        socket
            .try_clone()
            .map_err(|e| format!("prepare SSH transport abort failed: {e}"))?,
    );
    let socket = tokio::net::TcpStream::from_std(socket)
        .map_err(|e| format!("prepare SSH transport failed: {e}"))?;
    let (handle, disconnected, verified_host_key, reverse_hub) =
        connect_authenticated_stream(params, on_event, cancel, socket).await?;
    Ok((
        handle,
        disconnected,
        verified_host_key,
        transport_abort,
        reverse_hub,
    ))
}

async fn emit_output(
    output_flow: &OutputFlow,
    on_event: &IpcChannel<PtyEvent>,
    bytes: Vec<u8>,
) -> bool {
    let byte_len = bytes.len();
    if !output_flow.reserve(byte_len).await {
        return false;
    }
    let sent = on_event
        .send(PtyEvent::Data {
            data: B64.encode(bytes),
        })
        .is_ok();
    if !sent {
        output_flow.acknowledge(byte_len);
        output_flow.close();
    }
    sent
}

async fn bounded_final_flush<F>(output_flow: &OutputFlow, timeout: Duration, flush: F) -> bool
where
    F: Future<Output = bool>,
{
    let flushed = tokio::time::timeout(timeout, flush).await.unwrap_or(false);
    if !flushed {
        output_flow.close();
    }
    flushed
}

fn send_connection_status(on_event: &IpcChannel<PtyEvent>, phase: &str) {
    let _ = on_event.send(PtyEvent::ConnectionStatus {
        phase: phase.to_string(),
    });
}

fn push_shell_output(
    output: &mut SshOutputBatch,
    bootstrap_filter: &mut Option<SshBootstrapOutputFilter>,
    data: &[u8],
) -> Vec<Vec<u8>> {
    let Some(filter) = bootstrap_filter.as_mut() else {
        return output.push(data);
    };
    let visible = filter.push(data);
    let complete = filter.is_complete();
    let ready = output.push(&visible);
    if complete {
        *bootstrap_filter = None;
    }
    ready
}

impl SshSession {
    /// Connect, authenticate, open a shell PTY, and start pumping output into
    /// `on_event`. Returns once the shell is live; output streaming continues
    /// on a background tokio task.
    #[allow(dead_code)] // retained for real-sshd fixtures and direct connector consumers
    pub async fn open(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
    ) -> Result<SshSession, String> {
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
        Self::open_with_cancel(params, on_event, cancel).await
    }

    pub async fn open_with_cancel(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        let (handle, disconnected, verified_host_key, transport_abort, reverse_hub) =
            connect_direct_authenticated(&params, on_event.clone(), cancel.clone()).await?;
        Self::open_authenticated(
            params,
            on_event,
            handle,
            disconnected,
            None,
            verified_host_key,
            transport_abort,
            reverse_hub,
            cancel,
        )
        .await
    }

    /// Connect the jump and target as independent SSH transports, then open a
    /// shell only on the target. Each hop runs its own host-key handler,
    /// authentication, and bounded handshake/auth stages.
    pub async fn open_via_jump(
        target: ConnectParams,
        jump: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<SshSession, RoutedOpenError> {
        let (jump_handle, _jump_disconnected, _jump_verified_host_key, transport_abort, _jump_hub) =
            connect_direct_authenticated(&jump, on_event.clone(), cancel.clone())
                .await
                .map_err(RoutedOpenError::Jump)?;
        let stream = super::direct_tcpip::into_stream(&jump_handle, &target.host, target.port)
            .await
            .map_err(RoutedOpenError::Jump)?;
        let (target_handle, target_disconnected, verified_host_key, reverse_hub) =
            connect_authenticated_stream(&target, on_event.clone(), cancel.clone(), stream)
                .await
                .map_err(RoutedOpenError::Target)?;
        Self::open_authenticated(
            target,
            on_event,
            target_handle,
            target_disconnected,
            Some(Arc::new(jump_handle)),
            verified_host_key,
            transport_abort,
            reverse_hub,
            cancel,
        )
        .await
        .map_err(RoutedOpenError::Target)
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_authenticated(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        handle: Handle<ClientHandler>,
        disconnected: watch::Receiver<bool>,
        jump_handle: Option<Arc<Handle<ClientHandler>>>,
        verified_host_key: Arc<std::sync::Mutex<Option<String>>>,
        transport_abort: Arc<std::net::TcpStream>,
        reverse_hub: ReverseForwardHub,
        cancel: watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        let handle = Arc::new(handle);
        let verified = verified_host_key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| "SSH server identity was not verified".to_string())?;
        Self::start_interactive_shell(
            params,
            on_event,
            SharedSshTransport {
                handle,
                transport_abort,
                jump_handle,
                sftp: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
                transport_lost: Arc::new(AtomicBool::new(false)),
                disconnected,
                host: String::new(),
                port: 0,
                user: String::new(),
                verified_host_key: verified,
                identity_file: None,
                jump_endpoint: None,
                reverse_hub,
            },
            cancel,
        )
        .await
    }

    pub async fn open_from_shared(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        shared: SharedSshTransport,
        cancel: watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        if shared.transport_lost.load(Ordering::Acquire) {
            return Err("SSH transport is no longer live".into());
        }
        send_connection_status(&on_event, "openingShell");
        Self::start_interactive_shell(params, on_event, shared, cancel).await
    }

    async fn start_interactive_shell(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        shared: SharedSshTransport,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        let handle = shared.handle.clone();
        let mut disconnected = shared.disconnected.clone();
        send_connection_status(&on_event, "openingShell");
        let channel =
            await_pending_shell_open(handle.clone(), &mut cancel, &mut disconnected).await?;
        if let Err(error) = await_shell_setup_stage(
            "request PTY",
            &mut cancel,
            &mut disconnected,
            channel.request_pty(
                false,
                "xterm-256color",
                params.cols as u32,
                params.rows as u32,
                0,
                0,
                &SSH_PTY_MODES,
            ),
        )
        .await
        {
            channel.finish().await;
            return Err(error);
        }
        if let Err(error) = await_shell_setup_stage(
            "request shell",
            &mut cancel,
            &mut disconnected,
            channel.request_shell(true),
        )
        .await
        {
            channel.finish().await;
            return Err(error);
        }

        // Stage shell integration and the saved cwd into one private bootstrap,
        // then type only a SHORT source line into the interactive shell. This
        // keeps long/unicode paths and the integration payload out of the tty's
        // canonical input limit. If staging is unavailable, a normal-sized cwd
        // still falls back to a directly typed, safely quoted `cd` command.
        let mut bootstrap_output_filter = None;
        if params.inject_shell_integration || params.initial_cwd.is_some() {
            let completion_marker = bootstrap_completion_marker(&params.session_id);
            let bootstrap_cancelled = AtomicBool::new(false);
            let bootstrap = stage_remote_bootstrap(
                &handle,
                &params.session_id,
                params.inject_shell_integration,
                params.initial_cwd.as_deref(),
                Some(&bootstrap_cancelled),
            );
            tokio::pin!(bootstrap);
            let staged = tokio::select! {
                biased;
                _ = cancel.changed() => {
                    bootstrap_cancelled.store(true, Ordering::Release);
                    let _ = (&mut bootstrap).await;
                    channel.finish().await;
                    return Err("SSH connection canceled".into());
                }
                _ = disconnected.changed() => {
                    bootstrap_cancelled.store(true, Ordering::Release);
                    let _ = (&mut bootstrap).await;
                    channel.finish().await;
                    return Err("SSH session closed".into());
                }
                result = &mut bootstrap => result,
            };
            match staged {
                Ok(path) => {
                    let line = integration_source_line(&path);
                    match await_shell_setup_stage(
                        "inject shell bootstrap",
                        &mut cancel,
                        &mut disconnected,
                        channel.data(line.as_bytes()),
                    )
                    .await
                    {
                        Ok(()) => {
                            bootstrap_output_filter = Some(SshBootstrapOutputFilter::new(
                                line.as_bytes(),
                                &completion_marker,
                            ));
                        }
                        Err(_) => log::debug!("ssh bootstrap inject failed"),
                    }
                }
                Err(_) => {
                    log::debug!("ssh bootstrap staging failed");
                    if let Some(cwd) = params.initial_cwd.as_deref() {
                        let line = initial_cwd_fallback_line(cwd, &params.session_id);
                        match await_shell_setup_stage(
                            "inject initial cwd",
                            &mut cancel,
                            &mut disconnected,
                            channel.data(line.as_bytes()),
                        )
                        .await
                        {
                            Ok(()) => {
                                bootstrap_output_filter = Some(SshBootstrapOutputFilter::new(
                                    line.as_bytes(),
                                    &completion_marker,
                                ));
                            }
                            Err(_) => {
                                log::debug!("ssh initial cwd fallback failed");
                            }
                        }
                    }
                }
            }
        }

        if *cancel.borrow() || *disconnected.borrow() {
            channel.finish().await;
            return Err(if *cancel.borrow() {
                "SSH connection canceled".into()
            } else {
                "SSH session closed".into()
            });
        }
        let mut channel = channel.into_inner();

        let (control, mut resize_rx) = SshControl::new();
        let pump_control = control.clone();
        let output_flow = OutputFlow::new();
        let pump_output_flow = output_flow.clone();
        let transport_lost = shared.transport_lost.clone();
        let pump_transport_lost = transport_lost.clone();
        let pump_handle = handle.clone();
        send_connection_status(&on_event, "ready");

        // Pump: remote output is coalesced behind a strict byte/time bound;
        // frontend Data, latest Resize, and Close each have independent control
        // paths. In particular, Close can cancel a channel.data().await parked
        // on SSH flow control instead of waiting behind a full paste queue.
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
            let mut output = SshOutputBatch::new();
            let mut flush_tick = tokio::time::interval(OUTPUT_BATCH_INTERVAL);
            flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            flush_tick.tick().await;
            let mut local_close = false;
            let mut confirmed_transport_lost = false;
            let mut connection_signal_open = true;
            let mut channel_ended = false;
            'pump: loop {
                tokio::select! {
                    biased;
                    _ = pump_control.wait_for_close() => {
                        local_close = true;
                        let _ = channel.eof().await;
                        break;
                    }
                    changed = disconnected.changed(), if connection_signal_open => {
                        connection_signal_open = false;
                        if changed.is_ok() && *disconnected.borrow_and_update() {
                            confirmed_transport_lost = true;
                        }
                    }
                    _ = flush_tick.tick() => {
                        if let Some(bytes) = output.flush() {
                            if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                local_close = true;
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        let Some(msg) = msg else { break };
                        match msg {
                            ChannelMsg::Data { ref data } => {
                                for bytes in push_shell_output(
                                    &mut output,
                                    &mut bootstrap_output_filter,
                                    data,
                                ) {
                                    if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                        local_close = true;
                                        break 'pump;
                                    }
                                }
                            }
                            // stderr (ext=1) is interleaved into the same stream;
                            // a terminal shows both on one screen.
                            ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                                for bytes in push_shell_output(
                                    &mut output,
                                    &mut bootstrap_output_filter,
                                    data,
                                ) {
                                    if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                        local_close = true;
                                        break 'pump;
                                    }
                                }
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
                            ChannelMsg::Eof | ChannelMsg::Close => {
                                channel_ended = true;
                                break;
                            }
                            _ => {}
                        }
                    }
                    input = pump_control.next_input(), if accepting_input => {
                        match input {
                            Some(input) => {
                                for chunk in input.bytes.chunks(INPUT_WRITE_CHUNK_BYTES) {
                                    tokio::select! {
                                        biased;
                                        _ = pump_control.wait_for_close() => {
                                            local_close = true;
                                            let _ = channel.eof().await;
                                            break 'pump;
                                        }
                                        result = channel.data(chunk) => {
                                            if result.is_err() {
                                                accepting_input = false;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            None => accepting_input = false,
                        }
                    }
                    changed = resize_rx.changed(), if accepting_input => {
                        if changed.is_err() {
                            accepting_input = false;
                            continue;
                        }
                        let size = *resize_rx.borrow_and_update();
                        if let Some((cols, rows)) = size {
                            tokio::select! {
                                biased;
                                _ = pump_control.wait_for_close() => {
                                    local_close = true;
                                    let _ = channel.eof().await;
                                    break 'pump;
                                }
                                _ = channel.window_change(cols as u32, rows as u32, 0, 0) => {}
                            }
                        }
                    }
                }
            }
            let pump_end = classify_pump_end(
                exit_code,
                local_close || pump_control.is_closed(),
                channel_ended,
                confirmed_transport_lost || *disconnected.borrow() || pump_handle.is_closed(),
            );
            if pump_end == PumpEnd::TransportLost {
                pump_transport_lost.store(true, Ordering::Release);
                let _ = on_event.send(PtyEvent::TransportLost {
                    reason: SSH_TRANSPORT_LOST_REASON.to_string(),
                });
            }

            // Preserve any unmatched bootstrap-filter suffix, but never let
            // its delivery delay the TransportLost control event or block
            // teardown indefinitely while renderer output credit is stalled.
            let mut final_output = Vec::new();
            if let Some(filter) = bootstrap_output_filter.take() {
                final_output.extend(output.push(&filter.finish()));
            }
            if let Some(bytes) = output.flush() {
                final_output.push(bytes);
            }
            let tail_bytes: usize = final_output.iter().map(Vec::len).sum();
            if tail_bytes > 0
                && !bounded_final_flush(&pump_output_flow, SSH_FINAL_OUTPUT_FLUSH_TIMEOUT, async {
                    for bytes in final_output {
                        if !emit_output(&pump_output_flow, &on_event, bytes).await {
                            return false;
                        }
                    }
                    true
                })
                .await
            {
                log::warn!("ssh: dropped {tail_bytes} buffered output bytes during final flush");
            }
            pump_output_flow.close();
            pump_control.request_close();
            let _ = on_event.send(PtyEvent::Exit {
                code: exit_code.unwrap_or(SSH_DISCONNECTED_EXIT_CODE),
            });
        });

        Ok(SshSession {
            handle,
            transport_abort: shared.transport_abort,
            _jump_handle: shared.jump_handle,
            control,
            output_flow,
            transport_lost,
            disconnected: shared.disconnected,
            host: params.host,
            port: params.port,
            user: params.auth.user,
            verified_host_key: shared.verified_host_key,
            logical_session_id: params.session_id,
            identity_file: params.auth.identity_file,
            jump_endpoint: params.jump_endpoint.or(shared.jump_endpoint),
            sftp: shared.sftp,
            reverse_hub: shared.reverse_hub,
        })
    }

    pub fn is_shareable(&self) -> bool {
        !self.is_closed() && !self.transport_lost()
    }

    pub fn matches_transport(
        &self,
        host: &str,
        port: u16,
        user: &str,
        identity_file: Option<&str>,
        jump_endpoint: Option<&(String, u16, String)>,
        exclude_logical_id: Option<&str>,
    ) -> bool {
        if exclude_logical_id.is_some_and(|id| id == self.logical_session_id) {
            return false;
        }
        if !self.host.eq_ignore_ascii_case(host) || self.port != port || self.user != user {
            return false;
        }
        if self.identity_file.as_deref() != identity_file {
            return false;
        }
        match (&self.jump_endpoint, jump_endpoint) {
            (None, None) => true,
            (Some(left), Some(right)) => {
                left.0.eq_ignore_ascii_case(&right.0) && left.1 == right.1 && left.2 == right.2
            }
            _ => false,
        }
    }

    pub fn share_transport(&self) -> Option<SharedSshTransport> {
        if !self.is_shareable() {
            return None;
        }
        Some(SharedSshTransport {
            handle: self.handle.clone(),
            transport_abort: self.transport_abort.clone(),
            jump_handle: self._jump_handle.clone(),
            sftp: self.sftp.clone(),
            transport_lost: self.transport_lost.clone(),
            disconnected: self.disconnected.clone(),
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            verified_host_key: self.verified_host_key.clone(),
            identity_file: self.identity_file.clone(),
            jump_endpoint: self.jump_endpoint.clone(),
            reverse_hub: self.reverse_hub.clone(),
        })
    }

    /// Immutable, non-secret identity used to bind transfer recovery records.
    pub fn transfer_identity(&self) -> (String, String, String) {
        (
            format!("{}:{}", self.host.to_ascii_lowercase(), self.port),
            self.user.clone(),
            self.verified_host_key.clone(),
        )
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

    /// Atomically replace `new_path` with `old_path` through OpenSSH's
    /// posix-rename extension. A dedicated channel lets us inspect negotiated
    /// extensions and avoids remote login-shell and platform-specific `mv`
    /// behavior entirely.
    pub async fn sftp_posix_rename(&self, old_path: &str, new_path: &str) -> Result<(), String> {
        let channel = await_stage(
            "open atomic rename SFTP channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request atomic rename SFTP subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }

        let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
        raw.set_timeout(SSH_CHANNEL_SETUP_TIMEOUT.as_secs());
        let result = async {
            let version = await_stage(
                "initialize atomic rename SFTP",
                SSH_CHANNEL_SETUP_TIMEOUT,
                raw.init(),
            )
            .await?;
            if version
                .extensions
                .get("posix-rename@openssh.com")
                .map(String::as_str)
                != Some("1")
            {
                return Err(
                    "remote SFTP server does not support safe atomic overwrite; upload with a new name"
                        .to_string(),
                );
            }
            let data = encode_posix_rename_request(old_path, new_path)?;
            match await_stage(
                "replace remote upload destination",
                SSH_CHANNEL_SETUP_TIMEOUT,
                raw.extended("posix-rename@openssh.com", data),
            )
            .await?
            {
                russh_sftp::protocol::Packet::Status(status)
                    if status.status_code == russh_sftp::protocol::StatusCode::Ok =>
                {
                    Ok(())
                }
                russh_sftp::protocol::Packet::Status(status) => {
                    Err(format!("atomic remote replacement failed: {}", status.error_message))
                }
                _ => Err("atomic remote replacement returned an unexpected response".into()),
            }
        }
        .await;
        let _ = raw.close_session();
        result
    }

    /// Check overwrite support before streaming bytes so unsupported servers
    /// fail without leaving a remote partial file.
    pub async fn supports_sftp_posix_rename(&self) -> Result<bool, String> {
        self.supports_sftp_extension("posix-rename@openssh.com")
            .await
    }

    /// Check whether a new regular file can be published atomically without
    /// replacing a racing destination.
    pub async fn supports_sftp_hardlink(&self) -> Result<bool, String> {
        self.supports_sftp_extension("hardlink@openssh.com").await
    }

    async fn supports_sftp_extension(&self, extension: &str) -> Result<bool, String> {
        let channel = await_stage(
            "open SFTP capability channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request SFTP capability subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }
        let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
        raw.set_timeout(SSH_CHANNEL_SETUP_TIMEOUT.as_secs());
        let result = await_stage(
            "initialize SFTP capability check",
            SSH_CHANNEL_SETUP_TIMEOUT,
            raw.init(),
        )
        .await
        .map(|version| version.extensions.get(extension).map(String::as_str) == Some("1"));
        let _ = raw.close_session();
        result
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
            crate::modules::perf_counters::sftp_readdir();
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

    // These run on the sync Tauri command thread. Reserving bytes and enqueueing
    // one complete batch happen in one lock, so a rejected paste is all-or-none
    // and no caller blocks on network flow control.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.control.try_enqueue(data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.control.resize(cols, rows)
    }

    /// Close is idempotent and independent from Data/Resize backpressure. The
    /// pump observes it with biased priority and can cancel an in-flight write.
    pub fn close(&self) -> Result<(), String> {
        self.output_flow.close();
        self.control.request_close();
        Ok(())
    }

    pub fn acknowledge_output(&self, bytes: usize) {
        self.output_flow.acknowledge(bytes);
    }

    pub fn identity(&self) -> (&str, u16, &str, &str) {
        (&self.host, self.port, &self.user, &self.logical_session_id)
    }

    pub fn is_closed(&self) -> bool {
        self.control.is_closed()
    }

    pub async fn wait_closed(&self) {
        self.control.wait_for_close().await;
    }

    pub fn transport_lost(&self) -> bool {
        self.transport_lost.load(Ordering::Acquire)
    }

    pub fn reverse_forward_hub(&self) -> &ReverseForwardHub {
        &self.reverse_hub
    }

    pub async fn request_tcpip_forward(&self, address: &str, port: u32) -> Result<u32, String> {
        if self.is_closed() {
            return Err("SSH session closed".into());
        }
        tokio::time::timeout(
            Duration::from_secs(10),
            self.handle.tcpip_forward(address.to_string(), port),
        )
        .await
        .map_err(|_| "SSH remote forward request timed out".to_string())?
        .map_err(|error| format!("SSH remote forward rejected: {error}"))
    }

    pub async fn cancel_tcpip_forward(&self, address: &str, port: u32) -> Result<(), String> {
        if self.is_closed() {
            return Ok(());
        }
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            self.handle.cancel_tcpip_forward(address.to_string(), port),
        )
        .await;
        Ok(())
    }

    /// Open the exact RFC 4254 direct-tcpip target through this already
    /// authenticated SSH connection. The caller supplies only a validated
    /// loopback host and port; this API never invokes a remote shell.
    pub async fn probe_direct_tcpip(&self, host: &str, port: u16) -> Result<(), String> {
        super::direct_tcpip::probe(self, host, port).await
    }

    pub(crate) async fn probe_direct_tcpip_inner(
        &self,
        host: &str,
        port: u16,
    ) -> Result<(), String> {
        if self.is_closed() {
            return Err("SSH session closed".into());
        }
        let channel = tokio::time::timeout(
            Duration::from_secs(5),
            self.handle
                .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0),
        )
        .await
        .map_err(|_| "SSH port forward probe timed out".to_string())?
        .map_err(|error| format!("SSH port forward target rejected: {error}"))?;
        let _ = channel.close().await;
        Ok(())
    }

    /// Bridge one accepted local loopback socket to the exact caller-validated
    /// remote target over a dedicated direct-tcpip channel.
    pub async fn forward_loopback_stream(
        &self,
        stream: tokio::net::TcpStream,
        host: &str,
        port: u16,
    ) -> Result<(), String> {
        let (cancel, cancelled) = watch::channel(false);
        let result = super::direct_tcpip::relay(self, stream, host, port, cancelled).await;
        drop(cancel);
        result
    }

    async fn open_forward_channel(
        &self,
        host: &str,
        port: u16,
        origin: std::net::SocketAddr,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<ForwardChannel, String> {
        let handle = self.handle.clone();
        let host = host.to_string();
        let open = async move {
            handle
                .channel_open_direct_tcpip(
                    host,
                    u32::from(port),
                    origin.ip().to_string(),
                    u32::from(origin.port()),
                )
                .await
                .map(ForwardChannel::new)
                .map_err(|error| format!("SSH port forward channel failed: {error}"))
        };
        await_pending_forward_open(open, cancelled, self.wait_closed(), Duration::from_secs(5))
            .await
    }

    pub(crate) async fn forward_loopback_stream_inner(
        &self,
        stream: tokio::net::TcpStream,
        host: &str,
        port: u16,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), String> {
        if self.is_closed() || *cancelled.borrow() {
            return Err("SSH session closed".into());
        }
        let origin = stream
            .peer_addr()
            .map_err(|error| format!("local forward peer unavailable: {error}"))?;
        let channel = self
            .open_forward_channel(host, port, origin, &mut cancelled)
            .await?;
        self.relay_direct_tcpip(stream, channel, cancelled).await
    }

    /// Open a dynamic-forward target and acknowledge SOCKS only once the SSH
    /// server has accepted the direct-tcpip channel.
    pub(crate) async fn forward_socks_stream_inner(
        &self,
        mut stream: tokio::net::TcpStream,
        host: &str,
        port: u16,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), String> {
        if self.is_closed() || *cancelled.borrow() {
            let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err("SSH session closed".into());
        }
        let origin = match stream.peer_addr() {
            Ok(origin) => origin,
            Err(error) => {
                let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err(format!("dynamic forward peer unavailable: {error}"));
            }
        };
        let channel = match self
            .open_forward_channel(host, port, origin, &mut cancelled)
            .await
        {
            Ok(channel) => channel,
            Err(error) => {
                let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err(error);
            }
        };
        if let Err(error) = stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await {
            channel.finish().await;
            return Err(format!("SOCKS success reply failed: {error}"));
        }
        self.relay_direct_tcpip(stream, channel, cancelled).await
    }

    async fn relay_direct_tcpip(
        &self,
        mut stream: tokio::net::TcpStream,
        mut channel: ForwardChannel,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let mut local_closed = false;
        let mut remote_closed = false;
        let mut buffer = vec![0_u8; 64 * 1024];
        let result = loop {
            if direct_tcpip_relay_complete(local_closed, remote_closed) {
                break Ok(());
            }
            tokio::select! {
                biased;
                _ = cancelled.changed() => break Err("local forward cancelled".into()),
                _ = self.wait_closed() => break Err("SSH session closed".into()),
                read = stream.read(&mut buffer), if !local_closed => match read {
                    Ok(0) => {
                        local_closed = true;
                        tokio::select! {
                            biased;
                            _ = cancelled.changed() => break Err("local forward cancelled".into()),
                            _ = self.wait_closed() => break Err("SSH session closed".into()),
                            result = channel.eof() => if let Err(error) = result { break Err(error.to_string()); },
                        }
                    }
                    Ok(count) => tokio::select! {
                        biased;
                        _ = cancelled.changed() => break Err("local forward cancelled".into()),
                        _ = self.wait_closed() => break Err("SSH session closed".into()),
                        result = channel.data(&buffer[..count]) => if let Err(error) = result { break Err(error.to_string()); },
                    },
                    Err(error) => break Err(format!("local forward read failed: {error}")),
                },
                message = channel.wait(), if !remote_closed => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => tokio::select! {
                        biased;
                        _ = cancelled.changed() => break Err("local forward cancelled".into()),
                        _ = self.wait_closed() => break Err("SSH session closed".into()),
                        result = stream.write_all(&data) => if let Err(error) = result { break Err(format!("local forward write failed: {error}")); },
                    },
                    Some(ChannelMsg::Eof) => {
                        remote_closed = true;
                        if let Err(error) = stream.shutdown().await { break Err(format!("local forward half-close failed: {error}")); }
                    }
                    Some(ChannelMsg::Close) | None => break Ok(()),
                    _ => {}
                }
            }
        };
        channel.finish().await;
        let _ = stream.shutdown().await;
        result
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
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            None,
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
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            Some(cancelled.as_ref()),
            None,
        )
        .await
    }

    /// Execute a probe where a non-zero status is part of the caller's state
    /// machine rather than a transport failure (for example, Git with no
    /// upstream). All other SSH commands should use `exec`.
    #[cfg(test)]
    pub async fn exec_allow_nonzero(
        &self,
        command: &str,
        max_bytes: usize,
    ) -> Result<String, String> {
        exec_on(
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            true,
            None,
            None,
        )
        .await
    }

    #[cfg(test)]
    pub(super) async fn exec_with_test_request_hook(
        &self,
        command: &str,
        max_bytes: usize,
        request_accepted: &(dyn Fn() + Sync),
    ) -> Result<String, String> {
        exec_on(
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            None,
            Some(request_accepted),
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
    handle: Arc<Handle<ClientHandler>>,
    command: &str,
    max_bytes: usize,
    timeout: Duration,
    allow_nonzero: bool,
    cancelled: Option<&AtomicBool>,
    request_accepted: Option<&(dyn Fn() + Sync)>,
) -> Result<String, String> {
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        return Err("remote command cancelled".into());
    }
    let mut channel = await_pending_exec_open(handle, cancelled).await?;
    crate::modules::perf_counters::ssh_exec_channel();
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        channel.finish().await;
        return Err("remote command cancelled".into());
    }
    if let Err(error) = await_stage(
        "start remote command",
        SSH_CHANNEL_SETUP_TIMEOUT,
        channel.exec(true, command),
    )
    .await
    {
        channel.finish().await;
        return Err(error);
    }
    if let Some(notify) = request_accepted {
        notify();
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
    channel.finish().await;

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
    handle: &Arc<Handle<ClientHandler>>,
    session_id: &str,
    inject_shell_integration: bool,
    initial_cwd: Option<&str>,
    cancelled: Option<&AtomicBool>,
) -> Result<String, String> {
    let script = render_remote_bootstrap(session_id, inject_shell_integration, initial_cwd);
    let encoded = B64.encode(script.as_bytes());
    let command = integration_stage_command(&encoded);
    let out = exec_on(
        handle.clone(),
        &command,
        4096,
        Duration::from_secs(5),
        false,
        cancelled,
        None,
    )
    .await?;
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

fn safe_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect()
}

fn bootstrap_completion_token(session_id: &str) -> String {
    format!("tunara-bootstrap;{}", safe_session_id(session_id))
}

fn bootstrap_completion_marker(session_id: &str) -> Vec<u8> {
    format!("\x1b]777;{}\x1b\\", bootstrap_completion_token(session_id)).into_bytes()
}

fn bootstrap_completion_command(session_id: &str) -> String {
    format!(
        "printf '\\033]777;{}\\033\\\\'",
        bootstrap_completion_token(session_id)
    )
}

fn render_remote_bootstrap(
    session_id: &str,
    inject_shell_integration: bool,
    initial_cwd: Option<&str>,
) -> String {
    // The output pump removes this private marker together with every tty echo
    // of the typed source line. Unlike relative cursor erasure, filtering the
    // exact generated bytes is independent of MOTD, prompt, and readline order.
    let mut script = format!("{}\n", bootstrap_completion_command(session_id));
    if inject_shell_integration {
        script.push_str(&render_remote_integration(session_id));
    }
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
    let safe_sid = safe_session_id(session_id);
    REMOTE_INTEGRATION
        .replace("__TUNARA_SESSION_ID__", &safe_sid)
        .replace("__TUNARA_AGENT_HOOK_B64__", &B64.encode(AGENT_HOOK_HELPER))
}

/// One-shot exec command that writes the base64 payload to a fresh `mktemp`
/// file and prints the path (and nothing else) on success. Tries the GNU then
/// BSD base64 decode flag; stderr is discarded so failures stay quiet.
fn integration_stage_command(encoded: &str) -> String {
    format!(
        "sh -c 'f=$(mktemp /tmp/.t-XXXXXXXXXX) && {{ printf %s {encoded} | base64 --decode 2>/dev/null || printf %s {encoded} | base64 -D 2>/dev/null; }} > \"$f\" && printf %s \"$f\"'"
    )
}

/// The ONLY line typed into the interactive shell: source the staged file,
/// then remove it. The path is unquoted only because `is_safe_remote_path`
/// restricts it to a shell-inert ASCII charset. Leading space keeps it out of
/// ignorespace-style history. Must stay far below 1024 bytes, the smallest
/// (BSD) canonical-mode tty line buffer. The output pump suppresses the exact
/// generated command until its completion marker arrives, including
/// both the tty's initial echo and any later readline redraw.
fn integration_source_line(path: &str) -> String {
    format!(" . {path};rm -f {path}\n")
}

fn initial_cwd_fallback_line(cwd: &str, session_id: &str) -> String {
    let completion = bootstrap_completion_command(session_id);
    let line = format!(" {completion};cd {}\n", shell_quote(cwd));
    if line.len() < 1_024 {
        line
    } else {
        format!(
            " {completion};printf '%s\\n' '[tunara] saved remote directory path is too long to restore'\n"
        )
    }
}

/// Accept only the path shape our own stage command can produce — an absolute
/// `/tmp/.t-*` path in a conservative charset. Anything else (error
/// text, MOTD noise, a hostile multi-line blob) must not reach the shell line.
fn is_safe_remote_path(path: &str) -> bool {
    path.starts_with("/tmp/.t-")
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
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn posix_rename_request_preserves_two_exact_wire_paths() {
        let old = "/srv/-tmp/可爱 ' draft.tmp";
        let new = "/srv/-tmp/最终 ' file.txt";
        let encoded = encode_posix_rename_request(old, new).expect("encode request");
        let expected = [
            (old.len() as u32).to_be_bytes().as_slice(),
            old.as_bytes(),
            (new.len() as u32).to_be_bytes().as_slice(),
            new.as_bytes(),
        ]
        .concat();
        assert_eq!(encoded, expected);
    }

    #[test]
    fn pump_end_classification_only_reports_unexpected_transport_loss() {
        assert_eq!(
            classify_pump_end(Some(0), false, true, true),
            PumpEnd::RemoteExit
        );
        assert_eq!(
            classify_pump_end(Some(-1), false, true, true),
            PumpEnd::RemoteExit
        );
        assert_eq!(
            classify_pump_end(None, true, false, true),
            PumpEnd::LocalClose
        );
        assert_eq!(
            classify_pump_end(None, false, true, true),
            PumpEnd::TransportLost
        );
        assert_eq!(
            classify_pump_end(None, false, false, false),
            PumpEnd::ChannelEnded
        );
        assert_eq!(
            classify_pump_end(None, false, false, true),
            PumpEnd::TransportLost
        );
    }

    #[test]
    fn ssh_pty_modes_enable_utf8_input() {
        assert_eq!(SSH_PTY_MODES, [(russh::Pty::IUTF8, 1)]);
    }

    #[test]
    fn direct_tcpip_relay_preserves_both_half_closes() {
        assert!(!direct_tcpip_relay_complete(true, false));
        assert!(!direct_tcpip_relay_complete(false, true));
        assert!(direct_tcpip_relay_complete(true, true));
    }

    #[tokio::test]
    async fn cancelling_pending_multiplex_open_closes_late_channel_only() {
        #[derive(Clone, Debug)]
        struct MockChannel {
            closed: Arc<AtomicBool>,
            transport_closed: Arc<AtomicBool>,
            main_shell_closed: Arc<AtomicBool>,
        }
        impl Drop for MockChannel {
            fn drop(&mut self) {
                self.closed.store(true, Ordering::Release);
                // Model CHANNEL_CLOSE: this channel owns neither shared state.
                let _ = (&self.transport_closed, &self.main_shell_closed);
            }
        }

        let transport_closed = Arc::new(AtomicBool::new(false));
        let main_shell_closed = Arc::new(AtomicBool::new(false));
        let late_closed = Arc::new(AtomicBool::new(false));
        let (late_tx, late_rx) = oneshot::channel::<MockChannel>();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let (session_close_tx, session_close_rx) = oneshot::channel::<()>();

        let pending = await_pending_forward_open(
            async move { late_rx.await.map_err(|_| "mock open lost".to_string()) },
            &mut cancel_rx,
            async move {
                let _ = session_close_rx.await;
            },
            Duration::from_secs(5),
        );
        tokio::pin!(pending);
        tokio::task::yield_now().await;

        // A second channel on the same mock multiplex remains genuinely usable
        // while the first open is pending and then cancelled.
        let (mut shell_client, mut shell_server) = tokio::io::duplex(64);
        shell_client.write_all(b"ping").await.expect("shell write");
        let mut input = [0; 4];
        shell_server
            .read_exact(&mut input)
            .await
            .expect("shell read");
        assert_eq!(&input, b"ping");
        shell_server.write_all(b"pong").await.expect("shell reply");
        shell_client
            .read_exact(&mut input)
            .await
            .expect("shell reply read");
        assert_eq!(&input, b"pong");

        cancel_tx.send(true).expect("pending open receiver alive");
        let result = tokio::time::timeout(Duration::from_millis(100), &mut pending)
            .await
            .expect("only pending open cancellation completes");
        assert_eq!(result.unwrap_err(), "local forward cancelled");

        late_tx
            .send(MockChannel {
                closed: late_closed.clone(),
                transport_closed: transport_closed.clone(),
                main_shell_closed: main_shell_closed.clone(),
            })
            .map_err(drop)
            .expect("detached open still receives late channel");
        tokio::time::timeout(Duration::from_millis(100), async {
            while !late_closed.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late channel is closed by dropped open result");

        assert!(!transport_closed.load(Ordering::Acquire));
        assert!(!main_shell_closed.load(Ordering::Acquire));
        drop(session_close_tx);
    }

    #[test]
    fn transport_lost_event_has_a_stable_camel_case_contract() {
        let json = serde_json::to_value(PtyEvent::TransportLost {
            reason: SSH_TRANSPORT_LOST_REASON.to_string(),
        })
        .expect("serialize transport-lost event");
        assert_eq!(json["type"], "transportLost");
        assert_eq!(json["reason"], "transportClosed");
    }

    #[tokio::test]
    async fn bounded_final_flush_times_out_and_closes_output_flow() {
        let flow = OutputFlow::new();
        assert!(
            !bounded_final_flush(
                &flow,
                Duration::from_millis(1),
                std::future::pending::<bool>(),
            )
            .await
        );
        assert!(!flow.reserve(1).await, "closed flow must reject new output");
    }

    #[tokio::test]
    async fn bounded_final_flush_preserves_a_completed_flush() {
        let flow = OutputFlow::new();
        assert!(bounded_final_flush(&flow, Duration::from_secs(1), async { true }).await);
        assert!(flow.reserve(1).await, "successful flush leaves flow usable");
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and a working SSH agent"]
    async fn real_ssh_control_and_output_batch_smoke() {
        let host = std::env::var("TUNARA_SSH_SMOKE_HOST")
            .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
        let user = std::env::var("TUNARA_SSH_SMOKE_USER").unwrap_or_else(|_| "root".into());
        let port = std::env::var("TUNARA_SSH_SMOKE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let on_event = Channel::<PtyEvent>::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let session = tokio::time::timeout(
            Duration::from_secs(30),
            SshSession::open(
                ConnectParams {
                    host,
                    port,
                    auth: AuthOptions {
                        user,
                        method: super::super::auth::AuthMethod::Agent,
                        identity_file: None,
                        certificate_file: None,
                        key_passphrase: None,
                        password: None,
                    },
                    policy: HostKeyPolicy::AcceptUnknown,
                    cols: 80,
                    rows: 24,
                    initial_cwd: None,
                    inject_shell_integration: false,
                    session_id: "m1-real-smoke".into(),
                    transport_generation: "smoke".into(),
                    hop_role: "direct".into(),
                    jump_endpoint: None,
                },
                on_event,
            ),
        )
        .await
        .expect("SSH open timeout")
        .expect("SSH open");

        session.resize(90, 30).expect("first resize");
        session.resize(132, 43).expect("latest resize");
        let marker = "__TUNARA_M1_REAL_SSH_OK__";
        session
            .write(
                format!("head -c 131072 /dev/zero | tr '\\0' x; printf '\\n{marker}\\n'\n")
                    .as_bytes(),
            )
            .expect("write output fixture");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut output = Vec::new();
        let started = tokio::time::Instant::now();
        let mut data_events = 0usize;
        let completed = |bytes: &[u8]| {
            bytes
                .windows(marker.len())
                .enumerate()
                .any(|(offset, candidate)| {
                    candidate == marker.as_bytes()
                        && bytes[..offset].iter().filter(|byte| **byte == b'x').count() >= 131_072
                })
        };
        while !completed(&output) {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .expect("marker before deadline");
            let body = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect("SSH event timeout")
                .expect("SSH event channel open");
            let InvokeResponseBody::Json(json) = body else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(&json).expect("valid event JSON");
            if event.get("type").and_then(serde_json::Value::as_str) == Some("data") {
                data_events += 1;
                let encoded = event
                    .get("data")
                    .and_then(serde_json::Value::as_str)
                    .expect("data payload");
                output.extend(B64.decode(encoded).expect("base64 output"));
            }
        }
        assert!(completed(&output), "large output must arrive before marker");
        eprintln!(
            "real SSH smoke: {} output bytes in {} Data events over {} ms",
            output.len(),
            data_events,
            started.elapsed().as_millis()
        );

        session.close().expect("first close");
        session.close().expect("idempotent close");
        let exit_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = exit_deadline
                .checked_duration_since(tokio::time::Instant::now())
                .expect("Exit before deadline");
            let body = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect("Exit timeout")
                .expect("event channel open");
            let InvokeResponseBody::Json(json) = body else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(&json).expect("valid event JSON");
            if event.get("type").and_then(serde_json::Value::as_str) == Some("exit") {
                break;
            }
        }
    }

    /// Regression: the line typed into the interactive shell must stay far
    /// below the smallest canonical-mode tty line buffer (1024 on BSD/macOS,
    /// 4096 on Linux). The original inline-eval injection was ~11 KB; the
    /// line discipline dropped its tail (newline included), so the eval never
    /// ran and kilobytes of base64 were echoed and left pending at the first
    /// prompt. Payload bytes may only travel over the exec channel.
    #[test]
    fn source_line_fits_every_canonical_tty_buffer() {
        let line = integration_source_line("/tmp/.t-AbCd012345");
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
        assert!(
            line.len() < 64,
            "source command must stay on one typical prompt line"
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
        let line = integration_source_line("/tmp/.t-AbCd012345");
        assert!(!line.contains(&encoded[..32]));
    }

    #[test]
    fn remote_bootstrap_restores_a_shell_quoted_unicode_cwd() {
        let cwd = "/srv/可爱动物/it's-here";
        let rendered = render_remote_bootstrap("session-1", true, Some(cwd));
        assert!(rendered.starts_with("printf '\\033]777;tunara-bootstrap;session-1\\033\\\\'\n"));
        assert_eq!(
            bootstrap_completion_marker("session-1"),
            b"\x1b]777;tunara-bootstrap;session-1\x1b\\"
        );
        assert!(rendered.contains("cd '/srv/可爱动物/it'\"'\"'s-here'"));
        assert!(rendered.contains("saved remote directory unavailable"));
        assert!(rendered.contains("session-1"));
        let line = integration_source_line("/tmp/.t-AbCd012345");
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
            initial_cwd_fallback_line("/srv/my app", "session-1"),
            " printf '\\033]777;tunara-bootstrap;session-1\\033\\\\';cd '/srv/my app'\n"
        );
        let long = format!("/{}", "'".repeat(4_096));
        let line = initial_cwd_fallback_line(&long, "session-1");
        assert!(line.len() < 1_024);
        assert!(line.contains("too long"));
    }

    #[test]
    fn stage_output_path_is_validated() {
        assert!(is_safe_remote_path("/tmp/.t-aB3xY9_qWe"));
        // Error text, prompts, or anything shell-active must be rejected.
        assert!(!is_safe_remote_path(""));
        assert!(!is_safe_remote_path("mktemp: not found"));
        assert!(!is_safe_remote_path("/tmp/.t-x; rm -rf ~"));
        assert!(!is_safe_remote_path("/tmp/.t-x\n/etc/passwd"));
        assert!(!is_safe_remote_path("/tmp/evil-si-abc"));
        assert!(!is_safe_remote_path("/tmp/.t-x y"));
        assert!(!is_safe_remote_path("/tmp/.t-x\"$(id)\""));
    }

    #[tokio::test]
    async fn host_key_prompt_accepts_an_explicit_decision() {
        let (tx, rx) = oneshot::channel();
        tx.send(HostKeyDecision {
            accept: true,
            remember: true,
        })
        .expect("decision receiver alive");
        assert!(
            await_host_key_decision(rx, Duration::from_secs(1))
                .await
                .accept
        );
    }

    #[tokio::test]
    async fn host_key_prompt_timeout_fails_closed() {
        let (_tx, rx) = oneshot::channel();
        assert!(
            !await_host_key_decision(rx, Duration::from_millis(1))
                .await
                .accept
        );
    }

    #[tokio::test]
    async fn host_key_prompt_attempt_cancellation_fails_closed_promptly() {
        let (_decision_tx, decision_rx) = oneshot::channel();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let waiting =
            await_host_key_decision_or_cancel(decision_rx, Duration::from_secs(120), cancel_rx);
        tokio::pin!(waiting);
        tokio::task::yield_now().await;
        cancel_tx.send(true).expect("cancel receiver alive");
        let decision = tokio::time::timeout(Duration::from_millis(50), waiting)
            .await
            .expect("attempt cancellation must wake host-key waiter");
        assert!(!decision.accept);
        assert!(!decision.remember);
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
