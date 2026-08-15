//! SSH client: a russh-backed remote shell that lives inside [`PtyState`].
//!
//! [`ssh_open`] connects + authenticates (async, on the Tokio runtime), then
//! inserts a `Session::Ssh` into [`crate::modules::pty::PtyState`] under a fresh
//! id — so the local `pty_write` / `pty_resize` / `pty_close` commands drive a
//! remote session transparently, output bridged through the same `PtyEvent`
//! channel. Submodules:
//! - [`auth`]: key/passphrase/password/agent auth options.
//! - [`connection`]: the live `SshSession` (one russh `Handle`), host-key policy.
//! - [`known_hosts`]: TOFU verification against `~/.ssh/known_hosts` (hashed
//!   entries detected, not silently trusted).
//! - [`hosts`]: saved host profiles in `tunara/hosts.toml` — endpoint, auth
//!   method, and an optional identity-file path, never passwords or passphrases.
//! - [`sftp`]: read-only remote browse + home-confined download.
//!
//! An unverifiable host key parks `ssh_open` and emits `PtyEvent::HostKeyPrompt`;
//! the user's answer arrives via [`ssh_host_key_decision`]. Commands:
//! [`ssh_open`], [`ssh_host_key_decision`], `ssh_hosts_load`/`save`/`remove`,
//! `ssh_fs_read_dir`/`read_file`/`download`/`home`.
//
// SSH client module (§ssh-client).
//
// Phase 1: connect + authenticate + interactive remote shell, bridged to
// xterm.js through the existing PtyEvent path. SSH sessions live alongside
// local PTYs in `PtyState` via the `Session::Ssh` variant, so the existing
// pty_write / pty_resize / pty_close commands work for both transparently.

pub mod auth;
pub mod connection;
pub mod diagnostics;
pub mod direct_tcpip;
mod flow_control;
pub mod forwarding;
pub mod hosts;
pub mod known_hosts;
pub(crate) mod local_safe_write;
#[cfg(feature = "m2-safe-write-benchmark")]
pub(crate) mod m2_safe_write_benchmark;
pub mod remote_fs;
pub mod remote_git;
#[cfg(test)]
mod rtt_benchmark;
mod safe_write;
pub mod sftp;
pub mod sftp_common;
pub mod transfer;
pub mod transfer_journal;

/// Stable, non-sensitive error classes exposed across the IPC boundary.
#[derive(Clone, Copy, Debug)]
pub(crate) enum SshIpcErrorKind {
    OpenLegacy,
    HostDecision,
    KeyboardInteractive,
    Hosts,
    KnownHosts,
    SftpRead,
    SftpWrite,
    Transfer,
    Manifest,
    Journal,
    RemoteFs,
    Forwarding,
    RemoteGit,
}

/// Converts internal SSH failures to a fixed wire-safe message. `raw` is used
/// only for allowlisted semantic classification; it is never formatted into
/// the result or logged.
pub(crate) fn safe_ipc_error(kind: SshIpcErrorKind, raw: impl std::fmt::Display) -> String {
    log::warn!("SSH IPC operation failed: {kind:?}");
    let raw = raw.to_string().to_ascii_lowercase();
    if matches!(kind, SshIpcErrorKind::Transfer) {
        let code = if raw.contains("remote destination already exists") {
            "SSH_TRANSFER_DESTINATION_EXISTS"
        } else if raw.contains("upload cancelled") || raw.contains(r#""kind":"cancelled""#) {
            "SSH_TRANSFER_CANCELLED"
        } else if raw.contains("does not support safe atomic overwrite")
            || raw.contains(r#""kind":"unsupported""#)
        {
            "SSH_TRANSFER_UNSUPPORTED"
        } else if raw.contains("permissions changed during upload")
            || raw.contains(r#""kind":"changed""#)
        {
            "SSH_TRANSFER_CHANGED"
        } else if raw.contains("outcome unknown after replacement")
            || raw.contains(r#""kind":"uncertain""#)
        {
            "SSH_TRANSFER_OUTCOME_UNKNOWN"
        } else if raw.contains("partial upload may remain") || raw.contains(r#""kind":"partial""#) {
            "SSH_TRANSFER_PARTIAL"
        } else {
            "SSH_TRANSFER_FAILED"
        };
        return code.to_string();
    }
    if matches!(kind, SshIpcErrorKind::Forwarding) {
        let code = if raw.contains("stale") || raw.contains("generation changed") {
            "SSH_FORWARDING_STALE_BINDING"
        } else if raw.contains("limit") {
            "SSH_FORWARDING_LIMIT_EXCEEDED"
        } else if raw.contains("cannot bind") || raw.contains("address already in use") {
            "SSH_FORWARDING_FIXED_PORT_UNAVAILABLE"
        } else if raw.contains("invalid") || raw.contains("must be") || raw.contains("non-zero") {
            "SSH_FORWARDING_INVALID_INTENT"
        } else {
            "SSH_FORWARDING_FAILED"
        };
        return code.to_string();
    }
    if matches!(kind, SshIpcErrorKind::RemoteFs) && raw.contains("remote path not found") {
        return "SSH_REMOTE_FS_NOT_FOUND".into();
    }
    match kind {
        SshIpcErrorKind::OpenLegacy => "SSH_OPEN_FAILED",
        SshIpcErrorKind::HostDecision => "SSH_HOST_DECISION_FAILED",
        SshIpcErrorKind::KeyboardInteractive => "SSH_KEYBOARD_INTERACTIVE_FAILED",
        SshIpcErrorKind::Hosts => "SSH_HOSTS_FAILED",
        SshIpcErrorKind::KnownHosts => "SSH_KNOWN_HOSTS_FAILED",
        SshIpcErrorKind::SftpRead => "SSH_SFTP_READ_FAILED",
        SshIpcErrorKind::SftpWrite => "SSH_SFTP_WRITE_FAILED",
        SshIpcErrorKind::Transfer => "SSH_TRANSFER_FAILED",
        SshIpcErrorKind::Manifest => "SSH_MANIFEST_FAILED",
        SshIpcErrorKind::Journal => "SSH_JOURNAL_FAILED",
        SshIpcErrorKind::RemoteFs => "SSH_REMOTE_FS_FAILED",
        SshIpcErrorKind::Forwarding => "SSH_FORWARDING_FAILED",
        SshIpcErrorKind::RemoteGit => "SSH_REMOTE_GIT_FAILED",
    }
    .to_string()
}

#[cfg(test)]
mod safe_ipc_error_tests {
    use super::{safe_ipc_error, SshIpcErrorKind};

    #[test]
    fn command_error_mapper_serialization_is_fixed_and_drops_every_canary() {
        const PRIVATE_KEY_PATH: &str = "/home/alice/.ssh/id_ed25519";
        const AGENT_SOCKET: &str = "/run/user/1000/ssh-agent.private.sock";
        const SECRET: &str = "passphrase=correct-horse-battery-staple";
        const SFTP_STATUS: &str = "SSH_FX_PERMISSION_DENIED(raw-status=3)";
        let canary =
            format!("key={PRIVATE_KEY_PATH}; agent={AGENT_SOCKET}; {SECRET}; sftp={SFTP_STATUS}");
        let cases = [
            (SshIpcErrorKind::OpenLegacy, "SSH_OPEN_FAILED"),
            (SshIpcErrorKind::HostDecision, "SSH_HOST_DECISION_FAILED"),
            (
                SshIpcErrorKind::KeyboardInteractive,
                "SSH_KEYBOARD_INTERACTIVE_FAILED",
            ),
            (SshIpcErrorKind::Hosts, "SSH_HOSTS_FAILED"),
            (SshIpcErrorKind::KnownHosts, "SSH_KNOWN_HOSTS_FAILED"),
            (SshIpcErrorKind::SftpRead, "SSH_SFTP_READ_FAILED"),
            (SshIpcErrorKind::SftpWrite, "SSH_SFTP_WRITE_FAILED"),
            (SshIpcErrorKind::Transfer, "SSH_TRANSFER_FAILED"),
            (SshIpcErrorKind::Manifest, "SSH_MANIFEST_FAILED"),
            (SshIpcErrorKind::Journal, "SSH_JOURNAL_FAILED"),
            // Both registered remote-fs metadata and chmod commands use this
            // mapper kind; retain both call-site canaries in the behavior test.
            (SshIpcErrorKind::RemoteFs, "SSH_REMOTE_FS_FAILED"),
            (SshIpcErrorKind::RemoteFs, "SSH_REMOTE_FS_FAILED"),
            (SshIpcErrorKind::Forwarding, "SSH_FORWARDING_FAILED"),
            (SshIpcErrorKind::RemoteGit, "SSH_REMOTE_GIT_FAILED"),
        ];
        for (kind, expected) in cases {
            let command_result: Result<(), String> = Err(safe_ipc_error(kind, &canary));
            let wire = serde_json::to_string(&command_result).expect("serialize command result");
            assert_eq!(wire, format!(r#"{{"Err":"{expected}"}}"#));
            for private_value in [PRIVATE_KEY_PATH, AGENT_SOCKET, SECRET, SFTP_STATUS] {
                assert!(!wire.contains(private_value), "IPC leaked {private_value}");
            }
        }
        assert_eq!(
            safe_ipc_error(
                SshIpcErrorKind::Transfer,
                "remote destination already exists"
            ),
            "SSH_TRANSFER_DESTINATION_EXISTS"
        );
        assert_eq!(
            safe_ipc_error(
                SshIpcErrorKind::Forwarding,
                "cannot bind: private OS detail"
            ),
            "SSH_FORWARDING_FIXED_PORT_UNAVAILABLE"
        );
    }
}

use auth::{AuthMethod, AuthOptions};
use connection::{ConnectParams, HostKeyPolicy, RoutedOpenError, SshSession};

use crate::modules::agent::{hooks::HookListenerState, wrapper};
use crate::modules::pty::{PtyEvent, PtyState, Session};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use diagnostics::{
    DiagnosticSeverity, HopRole, SessionBindingV1, SshCommandErrorV1, SshDiagnosticV1,
    SshErrorCode, SshStage,
};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEndpointV1 {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    pub identity_file: Option<String>,
    pub certificate_file: Option<String>,
    pub key_passphrase: Option<String>,
    pub password: Option<String>,
    pub auth_method: Option<AuthMethod>,
    pub accept_unknown_host_key: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshShellOptionsV1 {
    pub cwd: Option<String>,
    pub inject_shell_integration: Option<bool>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOpenRequestV2 {
    pub logical_session_id: Option<String>,
    pub open_attempt_id: String,
    pub endpoint: SshEndpointV1,
    /// Contract seam for flow B. A0 remains direct-only and rejects this
    /// explicitly rather than silently ignoring an unsupported route.
    pub jump: Option<SshEndpointV1>,
    pub shell: SshShellOptionsV1,
    /// Open a new shell channel on the live TCP transport of this logical session.
    pub share_with_logical_session_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOpenResultV2 {
    pub physical_pty_id: u32,
    pub transport_generation: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<SessionBindingV1>,
}

static NEXT_TRANSPORT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn next_transport_generation() -> String {
    // Opaque by contract: callers may compare/copy this value, never construct
    // or interpret it. Counter + process id is unique for this backend lifetime.
    let sequence = NEXT_TRANSPORT_GENERATION.fetch_add(1, Ordering::Relaxed);
    format!("tg-{}-{sequence}", std::process::id())
}

type OpenAttempt = (u64, oneshot::Sender<()>);
#[derive(Default)]
struct OpenAttemptState {
    pending: HashMap<String, OpenAttempt>,
    cancelled: VecDeque<(String, std::time::Instant)>,
    latest_pending_by_logical: HashMap<String, (String, u64)>,
}

const CANCEL_TOMBSTONE_LIMIT: usize = 1_024;
const CANCEL_TOMBSTONE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn prune_cancelled(state: &mut OpenAttemptState, now: std::time::Instant) {
    while state.cancelled.front().is_some_and(|(_, created)| {
        now.saturating_duration_since(*created) >= CANCEL_TOMBSTONE_TTL
            || state.cancelled.len() > CANCEL_TOMBSTONE_LIMIT
    }) {
        state.cancelled.pop_front();
    }
}

fn take_cancelled(state: &mut OpenAttemptState, id: &str) -> bool {
    if let Some(index) = state
        .cancelled
        .iter()
        .position(|(candidate, _)| candidate == id)
    {
        state.cancelled.remove(index);
        true
    } else {
        false
    }
}

static OPEN_ATTEMPTS: OnceLock<Mutex<OpenAttemptState>> = OnceLock::new();
static NEXT_OPEN_ATTEMPT: AtomicU64 = AtomicU64::new(1);

fn open_attempts() -> &'static Mutex<OpenAttemptState> {
    OPEN_ATTEMPTS.get_or_init(|| Mutex::new(OpenAttemptState::default()))
}

struct OpenAttemptGuard {
    open_attempt_id: String,
    attempt_id: u64,
    logical_session_id: Option<String>,
    completed: bool,
}

impl Drop for OpenAttemptGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(mut state) = open_attempts().lock() {
            if state
                .pending
                .get(&self.open_attempt_id)
                .is_some_and(|(id, _)| *id == self.attempt_id)
            {
                state.pending.remove(&self.open_attempt_id);
            }
            if let Some(logical_id) = self.logical_session_id.as_deref() {
                if state.latest_pending_by_logical.get(logical_id).is_some_and(
                    |(open_id, attempt_id)| {
                        open_id == &self.open_attempt_id && *attempt_id == self.attempt_id
                    },
                ) {
                    state.latest_pending_by_logical.remove(logical_id);
                }
            }
            take_cancelled(&mut state, &self.open_attempt_id);
        }
    }
}

impl OpenAttemptGuard {
    /// Publish only if this is still the newest pending open for its logical
    /// session. The state check and publication closure share one critical
    /// section, so cancel/register cannot linearize between them and let an
    /// older connection replace a newer live PTY.
    fn publish_if_current<T>(mut self, publish: impl FnOnce() -> T) -> Result<T, String> {
        let mut state = open_attempts()
            .lock()
            .map_err(|_| "SSH open attempt state is unavailable".to_string())?;
        let pending_is_current = state
            .pending
            .get(&self.open_attempt_id)
            .is_some_and(|(attempt_id, _)| *attempt_id == self.attempt_id);
        let logical_is_current = self.logical_session_id.as_deref().is_none_or(|logical_id| {
            state
                .latest_pending_by_logical
                .get(logical_id)
                .is_some_and(|(open_id, attempt_id)| {
                    open_id == &self.open_attempt_id && *attempt_id == self.attempt_id
                })
        });
        if !pending_is_current || !logical_is_current {
            return Err("SSH connection canceled or superseded".into());
        }

        state.pending.remove(&self.open_attempt_id);
        if let Some(logical_id) = self.logical_session_id.as_deref() {
            state.latest_pending_by_logical.remove(logical_id);
        }
        take_cancelled(&mut state, &self.open_attempt_id);
        self.completed = true;
        // Keep OPEN_ATTEMPTS locked until the backend PTY mapping is updated.
        // The closure is synchronous and must stay free of UI/window actions.
        Ok(publish())
    }
}

fn register_open_attempt(
    open_attempt_id: &str,
    logical_session_id: Option<&str>,
) -> (oneshot::Receiver<()>, OpenAttemptGuard) {
    let attempt_id = NEXT_OPEN_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    let mut sender = Some(sender);
    if let Ok(mut state) = open_attempts().lock() {
        prune_cancelled(&mut state, std::time::Instant::now());
        if let Some(logical_id) = logical_session_id {
            if let Some((previous_open_id, previous_attempt_id)) =
                state.latest_pending_by_logical.insert(
                    logical_id.to_string(),
                    (open_attempt_id.to_string(), attempt_id),
                )
            {
                let previous_is_pending = state
                    .pending
                    .get(&previous_open_id)
                    .is_some_and(|(id, _)| *id == previous_attempt_id);
                if previous_is_pending {
                    if let Some((_, previous)) = state.pending.remove(&previous_open_id) {
                        let _ = previous.send(());
                    }
                }
            }
        }
        if take_cancelled(&mut state, open_attempt_id) {
            let _ = sender.take().expect("open sender available").send(());
        } else if let Some((_, previous)) = state.pending.insert(
            open_attempt_id.to_string(),
            (attempt_id, sender.take().expect("open sender available")),
        ) {
            let _ = previous.send(());
        }
    } else if let Some(sender) = sender.take() {
        // Fail closed if the global attempt state is poisoned; otherwise this
        // open could never be canceled or prove that it is current.
        let _ = sender.send(());
    }
    (
        receiver,
        OpenAttemptGuard {
            open_attempt_id: open_attempt_id.to_string(),
            attempt_id,
            logical_session_id: logical_session_id.map(str::to_string),
            completed: false,
        },
    )
}

/// Supersede an in-flight SSH open before publishing a local PTY for the same
/// logical session. This shares the publication lock, so whichever operation
/// wins is ordered and a late SSH attempt cannot replace the local terminal.
pub(crate) fn cancel_pending_open_for_logical(logical_session_id: &str) -> bool {
    let sender = if let Ok(mut state) = open_attempts().lock() {
        let Some((open_attempt_id, attempt_id)) = state
            .latest_pending_by_logical
            .get(logical_session_id)
            .cloned()
        else {
            return false;
        };
        let is_current = state
            .pending
            .get(&open_attempt_id)
            .is_some_and(|(id, _)| *id == attempt_id);
        is_current
            .then(|| state.pending.remove(&open_attempt_id))
            .flatten()
            .map(|(_, sender)| sender)
    } else {
        return false;
    };
    sender.is_some_and(|sender| sender.send(()).is_ok())
}

async fn open_with_cancellation(
    params: ConnectParams,
    jump: Option<ConnectParams>,
    on_event: Channel<PtyEvent>,
    open_attempt_id: &str,
) -> Result<(SshSession, OpenAttemptGuard), String> {
    let logical_session_id = (!params.session_id.is_empty()).then_some(params.session_id.as_str());
    let (cancel, guard) = register_open_attempt(open_attempt_id, logical_session_id);
    let (cancel_transport, cancel_receiver) = tokio::sync::watch::channel(false);
    let ssh = tokio::select! {
        result = async {
            if let Some(jump) = jump {
                SshSession::open_via_jump(params, jump, on_event, cancel_receiver).await.map_err(|error| match error {
                    RoutedOpenError::Jump(message) => format!("jump hop: {message}"),
                    RoutedOpenError::Target(message) => format!("target hop: {message}"),
                })
            } else {
                SshSession::open_with_cancel(params, on_event, cancel_receiver).await
            }
        } => result,
        _ = cancel => {
            let _ = cancel_transport.send(true);
            Err("SSH connection canceled".to_string())
        },
    }?;
    Ok((ssh, guard))
}

fn validate_open_input(
    logical_session_id: Option<&str>,
    host: &str,
    port: u16,
    user: &str,
    identity_file: Option<&str>,
    cwd: Option<&str>,
) -> Result<(), String> {
    if host.is_empty()
        || host.len() > 1_024
        || host.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("SSH host must be a non-empty hostname or address without whitespace".into());
    }
    if port == 0 {
        return Err("SSH port must be between 1 and 65535".into());
    }
    if user.is_empty()
        || user.len() > 256
        || user.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("SSH user must be non-empty and contain no whitespace".into());
    }
    if let Some(id) = logical_session_id {
        if id.is_empty()
            || id.len() > 256
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err("invalid logical SSH session id".into());
        }
    }
    if let Some(path) = identity_file {
        if path.len() > 4_096 || path.chars().any(char::is_control) {
            return Err("invalid SSH identity-file path".into());
        }
    }
    if let Some(path) = cwd {
        if !path.starts_with('/') || path.len() > 4_096 || path.chars().any(char::is_control) {
            return Err("SSH cwd must be an absolute POSIX path without control characters".into());
        }
    }
    Ok(())
}

/// Open an SSH session and register it in `PtyState` under a fresh id, exactly
/// like `pty_open` does for local shells. The frontend then drives it through
/// the same pty_write/resize/close commands.
// Flat args map 1:1 to the JS `invoke("ssh_open", {...})` payload — a Tauri
// command can't take a struct here without changing the frontend contract.
#[allow(clippy::too_many_arguments)]
async fn ssh_open_impl(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    preview_state: tauri::State<'_, crate::modules::preview::PreviewWindowState>,
    hooks_state: tauri::State<'_, HookListenerState>,
    logical_session_id: Option<String>,
    open_attempt_id: String,
    host: String,
    port: Option<u16>,
    user: String,
    cwd: Option<String>,
    identity_file: Option<String>,
    certificate_file: Option<String>,
    key_passphrase: Option<String>,
    password: Option<String>,
    auth_method: Option<AuthMethod>,
    accept_unknown_host_key: Option<bool>,
    jump: Option<SshEndpointV1>,
    inject_shell_integration: Option<bool>,
    cols: u16,
    rows: u16,
    share_with_logical_session_id: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<SshOpenResultV2, String> {
    let port = port.unwrap_or(22);
    validate_open_input(
        logical_session_id.as_deref(),
        &host,
        port,
        &user,
        identity_file.as_deref(),
        cwd.as_deref(),
    )
    .map_err(|error| format!("target request: {error}"))?;
    if certificate_file
        .as_deref()
        .is_some_and(|path| path.len() > 4_096 || path.chars().any(char::is_control))
    {
        return Err("target request: invalid SSH certificate-file path".into());
    }
    if let Some(jump) = jump.as_ref() {
        validate_open_input(
            None,
            &jump.host,
            jump.port.unwrap_or(22),
            &jump.user,
            jump.identity_file.as_deref(),
            None,
        )
        .map_err(|error| format!("jump request: {error}"))?;
        if jump
            .certificate_file
            .as_deref()
            .is_some_and(|path| path.len() > 4_096 || path.chars().any(char::is_control))
        {
            return Err("jump request: invalid SSH certificate-file path".into());
        }
    }
    if open_attempt_id.is_empty()
        || open_attempt_id.len() > 256
        || !open_attempt_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("target request: invalid SSH open attempt id".into());
    }
    let mut params = ConnectParams {
        host: host.clone(),
        port,
        auth: AuthOptions {
            user,
            method: auth_method.ok_or("target request: SSH authentication method is required")?,
            identity_file,
            certificate_file,
            key_passphrase,
            password,
        },
        // Default to Prompt (the safe TOFU behavior): an unknown/unverifiable
        // host key now asks the user to confirm the fingerprint instead of
        // being silently trusted. `Some(true)` is an explicit "trust without
        // prompting" opt-in from the UI.
        policy: if accept_unknown_host_key == Some(true) {
            HostKeyPolicy::AcceptUnknown
        } else {
            HostKeyPolicy::Prompt
        },
        cols,
        rows,
        initial_cwd: cwd,
        // Default-on: remote shell integration gives cwd + command/agent
        // detection (incl. the OSC 777 agent wrappers that clear the "running"
        // badge when a remote agent exits). The UI sends an explicit `false`
        // to opt a session out; only a never-set value falls through to true.
        inject_shell_integration: inject_shell_integration.unwrap_or(true),
        // Substituted into the integration script so its OSC 777 agent events
        // carry a session field the frontend accepts. Empty disables the agent
        // wrappers but keeps OSC 7 / 133.
        session_id: logical_session_id.clone().unwrap_or_default(),
        transport_generation: open_attempt_id.clone(),
        hop_role: if jump.is_some() {
            "target".into()
        } else {
            "direct".into()
        },
        jump_endpoint: None,
    };
    let jump_params = jump
        .map(|jump| -> Result<ConnectParams, String> {
            Ok(ConnectParams {
                host: jump.host,
                port: jump.port.unwrap_or(22),
                auth: AuthOptions {
                    user: jump.user,
                    method: jump
                        .auth_method
                        .ok_or("jump SSH authentication method is required")?,
                    identity_file: jump.identity_file,
                    certificate_file: jump.certificate_file,
                    key_passphrase: jump.key_passphrase,
                    password: jump.password,
                },
                policy: if jump.accept_unknown_host_key == Some(true) {
                    HostKeyPolicy::AcceptUnknown
                } else {
                    HostKeyPolicy::Prompt
                },
                cols,
                rows,
                initial_cwd: None,
                inject_shell_integration: false,
                // Jump authentication is part of the same Tunara logical
                // session/open attempt. Keep that trusted ownership even
                // though shell integration is never injected on the jump.
                session_id: logical_session_id.clone().unwrap_or_default(),
                transport_generation: open_attempt_id.clone(),
                hop_role: "jump".into(),
                jump_endpoint: None,
            })
        })
        .transpose()
        .map_err(|error| format!("jump request: {error}"))?;
    if let Some(jump) = jump_params.as_ref() {
        params.jump_endpoint = Some((jump.host.clone(), jump.port, jump.auth.user.clone()));
    }

    let share_hint = share_with_logical_session_id.as_deref();
    let shared = state.find_shareable_ssh(
        &params.host,
        params.port,
        &params.auth.user,
        params.auth.identity_file.as_deref(),
        params.jump_endpoint.as_ref(),
        logical_session_id.as_deref(),
        share_hint,
    );
    let log_open_err = |e: &String| {
        log::error!(
            "{}",
            diagnostics::redacted_log_message(
                diagnostics::SshStage::OpenShell,
                diagnostics::SshErrorCode::Internal,
                e,
            )
        );
    };
    let (ssh, open_attempt) = if let Some(shared) = shared {
        let logical_id = (!params.session_id.is_empty()).then_some(params.session_id.as_str());
        let (_cancel, guard) = register_open_attempt(&open_attempt_id, logical_id);
        let ssh = connection::SshSession::open_from_shared(params, on_event, shared)
            .await
            .inspect_err(log_open_err)?;
        (ssh, guard)
    } else {
        open_with_cancellation(params, jump_params, on_event, &open_attempt_id)
            .await
            .inspect_err(log_open_err)?
    };

    // Build the replacement completely before touching the live-session map.
    // Authentication, host-key confirmation, and shell setup can all fail or
    // take time; killing the existing session before these complete turns a
    // failed reconnect into destructive data loss. PtyState::insert performs
    // the actual swap atomically and closes the old session only after `ssh`
    // is ready.
    // Allocate before publication. The generation and session enter PtyState's
    // single authoritative binding registry in the same critical section.
    let transport_generation = next_transport_generation();
    let ((id, replaced_id), binding) =
        open_attempt.publish_if_current(|| -> Result<_, String> {
            let replaced_id = logical_session_id
                .as_deref()
                .and_then(|logical_id| state.physical_for_logical(logical_id));
            if let Some(logical_id) = logical_session_id.as_deref() {
                let binding = state.insert_ssh(
                    std::sync::Arc::new(Session::Ssh(ssh)),
                    logical_id,
                    transport_generation.clone(),
                )?;
                Ok(((binding.physical_pty_id, replaced_id), Some(binding)))
            } else {
                let id = state.insert(std::sync::Arc::new(Session::Ssh(ssh)), None);
                Ok(((id, replaced_id), None))
            }
        })??;
    // Window/UI work stays outside OPEN_ATTEMPTS. `replaced_id` was captured
    // in the same publication critical section, so this cannot target a newer
    // connection even if another reconnect starts immediately afterwards.
    if let Some(old_id) = replaced_id {
        preview_state.close_tunnels_for_pty(&app, old_id);
    }
    if let Some(logical_id) = logical_session_id.as_deref() {
        wrapper::cleanup_hooks_settings(logical_id, hooks_state.agent_config_dir());
    }
    log::info!("ssh opened id={id}");
    Ok(SshOpenResultV2 {
        physical_pty_id: id,
        transport_generation,
        warnings: Vec::new(),
        binding,
    })
}

/// Legacy flat IPC adapter. Its command name, argument wire shape and `u32`
/// return are intentionally unchanged.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    preview_state: tauri::State<'_, crate::modules::preview::PreviewWindowState>,
    hooks_state: tauri::State<'_, HookListenerState>,
    logical_session_id: Option<String>,
    open_attempt_id: String,
    host: String,
    port: Option<u16>,
    user: String,
    cwd: Option<String>,
    identity_file: Option<String>,
    key_passphrase: Option<String>,
    password: Option<String>,
    auth_method: Option<AuthMethod>,
    accept_unknown_host_key: Option<bool>,
    inject_shell_integration: Option<bool>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    ssh_open_impl(
        app,
        state,
        preview_state,
        hooks_state,
        logical_session_id,
        open_attempt_id,
        host,
        port,
        user,
        cwd,
        identity_file,
        None,
        key_passphrase,
        password,
        auth_method,
        accept_unknown_host_key,
        None,
        inject_shell_integration,
        cols,
        rows,
        None,
        on_event,
    )
    .await
    .map(|result| result.physical_pty_id)
    .map_err(|error| safe_ipc_error(SshIpcErrorKind::OpenLegacy, error))
}

/// Versioned request/response adapter. The transport generation is allocated
/// only by the backend and binds the logical identity to the published PTY.
#[tauri::command]
pub async fn ssh_open_v2(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    preview_state: tauri::State<'_, crate::modules::preview::PreviewWindowState>,
    hooks_state: tauri::State<'_, HookListenerState>,
    request: SshOpenRequestV2,
    on_event: Channel<PtyEvent>,
) -> Result<SshOpenResultV2, SshCommandErrorV1> {
    if !request
        .logical_session_id
        .as_deref()
        .is_some_and(|id| !id.is_empty())
    {
        return Err(command_error(
            SshStage::Target,
            SshErrorCode::InvalidRequest,
            false,
            HopRole::Direct,
        ));
    }
    let endpoint = request.endpoint;
    let routed = request.jump.is_some();
    let shell = request.shell;
    ssh_open_impl(
        app,
        state,
        preview_state,
        hooks_state,
        request.logical_session_id,
        request.open_attempt_id,
        endpoint.host,
        endpoint.port,
        endpoint.user,
        shell.cwd,
        endpoint.identity_file,
        endpoint.certificate_file,
        endpoint.key_passphrase,
        endpoint.password,
        endpoint.auth_method,
        endpoint.accept_unknown_host_key,
        request.jump,
        shell.inject_shell_integration,
        shell.cols,
        shell.rows,
        request.share_with_logical_session_id,
        on_event,
    )
    .await
    .map_err(|error| {
        let (stage, hop_role, code, retryable) = classify_open_error(&error, routed);
        command_error(stage, code, retryable, hop_role)
    })
}

fn classify_open_error(error: &str, routed: bool) -> (SshStage, HopRole, SshErrorCode, bool) {
    let (hop_role, detail, invalid_request) =
        if let Some(detail) = error.strip_prefix("jump request: ") {
            (HopRole::Jump, detail, true)
        } else if let Some(detail) = error.strip_prefix("target request: ") {
            (
                if routed {
                    HopRole::Target
                } else {
                    HopRole::Direct
                },
                detail,
                true,
            )
        } else if let Some(detail) = error.strip_prefix("jump hop: ") {
            (HopRole::Jump, detail, false)
        } else if let Some(detail) = error.strip_prefix("target hop: ") {
            (HopRole::Target, detail, false)
        } else {
            (
                if routed {
                    HopRole::Target
                } else {
                    HopRole::Direct
                },
                error,
                false,
            )
        };
    let normalized = detail.to_ascii_lowercase();
    if invalid_request
        || normalized.contains("invalid")
        || normalized.contains("must be")
        || normalized.contains("is required")
        || normalized.contains("requires")
    {
        let stage = if hop_role == HopRole::Jump {
            SshStage::Jump
        } else {
            SshStage::Target
        };
        return (stage, hop_role, SshErrorCode::InvalidRequest, false);
    }
    let host_key_failure = normalized.contains("host key")
        || normalized.contains("host-key")
        || normalized.contains("server key");
    let auth_failure = normalized.contains("authentication")
        || normalized.contains("authenticate")
        || normalized.contains("permission denied")
        || normalized.contains("identity file")
        || normalized.contains("ssh agent");
    let dns_failure = normalized.contains("failed to lookup")
        || normalized.contains("name or service not known")
        || normalized.contains("nodename nor servname");
    let open_shell_failure = normalized.contains("open session")
        || normalized.contains("request pty")
        || normalized.contains("request shell");
    let stage = if host_key_failure {
        SshStage::HostKey
    } else if auth_failure {
        SshStage::Auth
    } else if normalized.contains("handshake") {
        SshStage::Handshake
    } else if open_shell_failure {
        SshStage::OpenShell
    } else if dns_failure {
        SshStage::Dns
    } else if normalized.contains("connect") || normalized.contains("direct-tcpip") {
        SshStage::Tcp
    } else if hop_role == HopRole::Jump {
        SshStage::Jump
    } else {
        SshStage::Target
    };
    let code = if normalized.contains("timed out") {
        SshErrorCode::Timeout
    } else if host_key_failure {
        SshErrorCode::HostKeyRejected
    } else if auth_failure {
        SshErrorCode::AuthenticationFailed
    } else if dns_failure {
        SshErrorCode::DnsFailed
    } else if normalized.contains("connect") || normalized.contains("direct-tcpip") {
        SshErrorCode::ConnectionRefused
    } else if matches!(stage, SshStage::Handshake | SshStage::OpenShell) {
        SshErrorCode::TransportClosed
    } else {
        SshErrorCode::Internal
    };
    let retryable = matches!(
        code,
        SshErrorCode::Timeout
            | SshErrorCode::DnsFailed
            | SshErrorCode::ConnectionRefused
            | SshErrorCode::TransportClosed
    );
    (stage, hop_role, code, retryable)
}

fn command_error(
    stage: SshStage,
    code: SshErrorCode,
    retryable: bool,
    hop_role: HopRole,
) -> SshCommandErrorV1 {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    SshCommandErrorV1 {
        diagnostic: SshDiagnosticV1 {
            schema_version: 1,
            stage,
            code,
            severity: DiagnosticSeverity::Error,
            retryable,
            hop_role,
            timestamp,
            binding: None,
            safe_context: None,
        },
    }
}

#[cfg(test)]
fn command_error_from_legacy(raw: &str) -> SshCommandErrorV1 {
    let (stage, hop_role, code, retryable) = classify_open_error(raw, false);
    command_error(stage, code, retryable, hop_role)
}

/// Cancel a still-connecting SSH attempt before it has a physical PTY id. The
/// frontend-generated attempt id also makes a cancel that arrives before the
/// open IPC registration unambiguous and race-safe.
#[tauri::command]
pub fn ssh_cancel_open(open_attempt_id: String) -> bool {
    if open_attempt_id.is_empty()
        || open_attempt_id.len() > 256
        || !open_attempt_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return false;
    }
    let sender = if let Ok(mut state) = open_attempts().lock() {
        let sender = state
            .pending
            .remove(&open_attempt_id)
            .map(|(_, sender)| sender);
        if sender.is_none() {
            // `cancel` and `open` are separate IPC calls. Remember a cancel
            // that wins the race so a later registration observes it.
            let now = std::time::Instant::now();
            prune_cancelled(&mut state, now);
            if let Some(index) = state
                .cancelled
                .iter()
                .position(|(id, _)| id == &open_attempt_id)
            {
                state.cancelled.remove(index);
            }
            state.cancelled.push_back((open_attempt_id, now));
            prune_cancelled(&mut state, now);
        }
        sender
    } else {
        return false;
    };
    sender.is_none_or(|sender| sender.send(()).is_ok())
}

/// Answer a pending host-key prompt (emitted as `PtyEvent::HostKeyPrompt`). The
/// in-flight `ssh_open` call is parked inside `check_server_key` waiting on this.
#[tauri::command]
pub fn ssh_host_key_decision(
    prompt_id: String,
    accept: bool,
    remember: Option<bool>,
) -> Result<(), String> {
    let result =
        if connection::resolve_host_key_prompt(&prompt_id, accept, remember.unwrap_or(true)) {
            Ok(())
        } else {
            // Unknown id = already resolved or timed out; not fatal.
            Err("host-key prompt no longer pending".into())
        };
    result.map_err(|error: String| safe_ipc_error(SshIpcErrorKind::HostDecision, error))
}

#[tauri::command]
pub fn ssh_keyboard_interactive_response(
    prompt_id: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    let result = if auth::resolve_keyboard_interactive_prompt(&prompt_id, responses) {
        Ok(())
    } else {
        Err("keyboard-interactive prompt no longer pending".into())
    };
    result.map_err(|error: String| safe_ipc_error(SshIpcErrorKind::KeyboardInteractive, error))
}

#[cfg(test)]
mod tests {
    use super::diagnostics::{SshErrorCode, SshStage};
    use super::{
        cancel_pending_open_for_logical, classify_open_error, command_error_from_legacy,
        next_transport_generation, prune_cancelled, register_open_attempt, ssh_cancel_open,
        validate_open_input, HopRole, OpenAttemptState, CANCEL_TOMBSTONE_LIMIT,
        CANCEL_TOMBSTONE_TTL,
    };

    #[test]
    fn validates_ssh_open_boundary_before_network_or_logging() {
        assert!(validate_open_input(
            Some("session-1"),
            "host.example",
            22,
            "deploy",
            Some("~/.ssh/id key"),
            Some("/srv/项目")
        )
        .is_ok());
        assert!(validate_open_input(None, "bad host", 22, "deploy", None, None).is_err());
        assert!(validate_open_input(None, "host", 0, "deploy", None, None).is_err());
        assert!(validate_open_input(None, "host", 22, "bad user", None, None).is_err());
        assert!(validate_open_input(Some("../other"), "host", 22, "deploy", None, None).is_err());
        assert!(validate_open_input(None, "host", 22, "deploy", Some("bad\0key"), None).is_err());
        assert!(validate_open_input(None, "host", 22, "deploy", None, Some("relative")).is_err());
        assert!(validate_open_input(None, "host", 22, "deploy", None, Some("/bad\npath")).is_err());
    }

    #[test]
    fn backend_transport_generations_are_unique_and_opaque() {
        let first = next_transport_generation();
        let second = next_transport_generation();
        assert_ne!(first, second);
        assert!(first.starts_with("tg-"));
    }

    #[test]
    fn v2_classifies_and_discards_legacy_backend_errors() {
        let canary = "CANARY-private-secret";
        let auth = command_error_from_legacy(&format!(
            "password authentication failed: rejected {canary}"
        ));
        assert_eq!(auth.diagnostic.stage, SshStage::Auth);
        assert_eq!(auth.diagnostic.code, SshErrorCode::AuthenticationFailed);
        assert!(!serde_json::to_string(&auth).unwrap().contains(canary));

        let timeout = command_error_from_legacy("connect private.example:22 timed out");
        assert_eq!(timeout.diagnostic.stage, SshStage::Tcp);
        assert_eq!(timeout.diagnostic.code, SshErrorCode::Timeout);

        let missing_method = command_error_from_legacy("SSH authentication method is required");
        assert_eq!(missing_method.diagnostic.stage, SshStage::Target);
        assert_eq!(missing_method.diagnostic.code, SshErrorCode::InvalidRequest);

        let dns = command_error_from_legacy("connect failed: failed to lookup address information");
        assert_eq!(dns.diagnostic.stage, SshStage::Dns);
        assert_eq!(dns.diagnostic.code, SshErrorCode::DnsFailed);

        let auth_timeout = command_error_from_legacy("SSH authentication timed out after 135s");
        assert_eq!(auth_timeout.diagnostic.stage, SshStage::Auth);
        assert_eq!(auth_timeout.diagnostic.code, SshErrorCode::Timeout);

        let shell = command_error_from_legacy("request shell failed: channel closed");
        assert_eq!(shell.diagnostic.stage, SshStage::OpenShell);
        assert_eq!(shell.diagnostic.code, SshErrorCode::TransportClosed);
    }

    #[test]
    fn routed_open_errors_preserve_hop_and_security_category() {
        assert_eq!(
            classify_open_error("jump request: SSH port must be between 1 and 65535", true),
            (
                SshStage::Jump,
                HopRole::Jump,
                SshErrorCode::InvalidRequest,
                false
            )
        );
        assert_eq!(
            classify_open_error("jump hop: SSH handshake failed: Unknown server key", true),
            (
                SshStage::HostKey,
                HopRole::Jump,
                SshErrorCode::HostKeyRejected,
                false
            )
        );
        assert_eq!(
            classify_open_error("target hop: SSH authentication failed: rejected", true),
            (
                SshStage::Auth,
                HopRole::Target,
                SshErrorCode::AuthenticationFailed,
                false
            )
        );
    }

    #[tokio::test]
    async fn pending_open_can_be_cancelled_by_attempt_id() {
        let attempt_id = "cancel-open-test";
        let (receiver, guard) = register_open_attempt(attempt_id, Some("cancel-session"));
        assert!(ssh_cancel_open(attempt_id.to_string()));
        assert!(receiver.await.is_ok());
        assert!(guard.publish_if_current(|| ()).is_err());
    }

    #[tokio::test]
    async fn cancel_before_registration_is_not_lost() {
        let attempt_id = "pre-cancel-open-test";
        assert!(ssh_cancel_open(attempt_id.to_string()));
        let (receiver, guard) = register_open_attempt(attempt_id, Some("pre-cancel-session"));
        assert!(receiver.await.is_ok());
        assert!(guard.publish_if_current(|| ()).is_err());
    }

    #[test]
    fn cancel_tombstones_evict_one_oldest_entry_and_expire() {
        let now = std::time::Instant::now();
        let mut state = OpenAttemptState::default();
        for index in 0..=CANCEL_TOMBSTONE_LIMIT {
            state.cancelled.push_back((format!("id-{index}"), now));
            prune_cancelled(&mut state, now);
        }
        assert_eq!(state.cancelled.len(), CANCEL_TOMBSTONE_LIMIT);
        assert!(!state.cancelled.iter().any(|(id, _)| id == "id-0"));
        assert!(state.cancelled.iter().any(|(id, _)| id == "id-1024"));

        state.cancelled.front_mut().unwrap().1 = now - CANCEL_TOMBSTONE_TTL;
        prune_cancelled(&mut state, now);
        assert_eq!(state.cancelled.len(), CANCEL_TOMBSTONE_LIMIT - 1);
    }

    #[tokio::test]
    async fn newer_logical_open_supersedes_an_older_attempt_before_publish() {
        let (older_cancel, older) =
            register_open_attempt("logical-order-older", Some("logical-order-session"));
        let (_newer_cancel, newer) =
            register_open_attempt("logical-order-newer", Some("logical-order-session"));

        assert!(older_cancel.await.is_ok());
        assert!(older.publish_if_current(|| "older").is_err());
        assert_eq!(newer.publish_if_current(|| "newer"), Ok("newer"));
    }

    #[tokio::test]
    async fn local_open_can_supersede_a_pending_ssh_attempt() {
        let (cancel, pending) =
            register_open_attempt("local-wins-open", Some("local-wins-session"));
        assert!(cancel_pending_open_for_logical("local-wins-session"));
        assert!(cancel.await.is_ok());
        assert!(pending.publish_if_current(|| ()).is_err());
    }

    #[test]
    fn opens_without_logical_ids_publish_independently() {
        let (_first_cancel, first) = register_open_attempt("unbound-open-first", None);
        let (_second_cancel, second) = register_open_attempt("unbound-open-second", None);
        assert_eq!(first.publish_if_current(|| 1), Ok(1));
        assert_eq!(second.publish_if_current(|| 2), Ok(2));
    }
}
