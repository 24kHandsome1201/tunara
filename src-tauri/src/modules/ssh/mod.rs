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
//! - [`hosts`]: saved host profiles in `tunara/hosts.toml` — host/port/user and
//!   an identity-file PATH only, never passwords or passphrases.
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
mod flow_control;
pub mod hosts;
pub mod known_hosts;
#[cfg(feature = "m2-safe-write-benchmark")]
pub(crate) mod m2_safe_write_benchmark;
pub mod remote_git;
#[cfg(test)]
mod rtt_benchmark;
mod safe_write;
pub mod sftp;

use auth::AuthOptions;
use connection::{ConnectParams, HostKeyPolicy, SshSession};

use crate::modules::agent::{hooks::HookListenerState, wrapper};
use crate::modules::pty::{PtyEvent, PtyState, Session};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

type OpenAttempt = (u64, oneshot::Sender<()>);
#[derive(Default)]
struct OpenAttemptState {
    pending: HashMap<String, OpenAttempt>,
    cancelled: HashSet<String>,
}

static OPEN_ATTEMPTS: OnceLock<Mutex<OpenAttemptState>> = OnceLock::new();
static NEXT_OPEN_ATTEMPT: AtomicU64 = AtomicU64::new(1);

fn open_attempts() -> &'static Mutex<OpenAttemptState> {
    OPEN_ATTEMPTS.get_or_init(|| Mutex::new(OpenAttemptState::default()))
}

struct OpenAttemptGuard {
    open_attempt_id: String,
    attempt_id: u64,
}

impl Drop for OpenAttemptGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = open_attempts().lock() {
            if state
                .pending
                .get(&self.open_attempt_id)
                .is_some_and(|(id, _)| *id == self.attempt_id)
            {
                state.pending.remove(&self.open_attempt_id);
            }
            state.cancelled.remove(&self.open_attempt_id);
        }
    }
}

fn register_open_attempt(open_attempt_id: &str) -> (oneshot::Receiver<()>, OpenAttemptGuard) {
    let attempt_id = NEXT_OPEN_ATTEMPT.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut state) = open_attempts().lock() {
        if state.cancelled.remove(open_attempt_id) {
            let _ = sender.send(());
        } else if let Some((_, previous)) = state
            .pending
            .insert(open_attempt_id.to_string(), (attempt_id, sender))
        {
            let _ = previous.send(());
        }
    }
    (
        receiver,
        OpenAttemptGuard {
            open_attempt_id: open_attempt_id.to_string(),
            attempt_id,
        },
    )
}

async fn open_with_cancellation(
    params: ConnectParams,
    on_event: Channel<PtyEvent>,
    open_attempt_id: &str,
) -> Result<SshSession, String> {
    let (cancel, _guard) = register_open_attempt(open_attempt_id);
    tokio::select! {
        result = SshSession::open(params, on_event) => result,
        _ = cancel => Err("SSH connection canceled".to_string()),
    }
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
    accept_unknown_host_key: Option<bool>,
    inject_shell_integration: Option<bool>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    let port = port.unwrap_or(22);
    validate_open_input(
        logical_session_id.as_deref(),
        &host,
        port,
        &user,
        identity_file.as_deref(),
        cwd.as_deref(),
    )?;
    if open_attempt_id.is_empty()
        || open_attempt_id.len() > 256
        || !open_attempt_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("invalid SSH open attempt id".into());
    }
    let params = ConnectParams {
        host: host.clone(),
        port,
        auth: AuthOptions {
            user,
            identity_file,
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
    };

    let ssh = open_with_cancellation(params, on_event, &open_attempt_id)
        .await
        .map_err(|e| {
            log::error!("ssh_open failed: {e}");
            e
        })?;

    // Build the replacement completely before touching the live-session map.
    // Authentication, host-key confirmation, and shell setup can all fail or
    // take time; killing the existing session before these complete turns a
    // failed reconnect into destructive data loss. PtyState::insert performs
    // the actual swap atomically and closes the old session only after `ssh`
    // is ready.
    if let Some(logical_id) = logical_session_id.as_deref() {
        if let Some(old_id) = state.physical_for_logical(logical_id) {
            preview_state.close_tunnels_for_pty(&app, old_id);
        }
    }
    let id = state.insert(
        std::sync::Arc::new(Session::Ssh(ssh)),
        logical_session_id.as_deref(),
    );
    if let Some(logical_id) = logical_session_id.as_deref() {
        wrapper::cleanup_hooks_settings(logical_id, hooks_state.agent_config_dir());
    }
    match logical_session_id {
        Some(lid) => log::info!("ssh opened id={id} host={host} logical_session_id={lid}"),
        None => log::info!("ssh opened id={id} host={host}"),
    }
    Ok(id)
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
            if state.cancelled.len() >= 1_024 {
                state.cancelled.clear();
            }
            state.cancelled.insert(open_attempt_id);
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
pub fn ssh_host_key_decision(prompt_id: String, accept: bool) -> Result<(), String> {
    if connection::resolve_host_key_prompt(&prompt_id, accept) {
        Ok(())
    } else {
        // Unknown id = already resolved or timed out; not fatal.
        Err("host-key prompt no longer pending".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{register_open_attempt, ssh_cancel_open, validate_open_input};

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

    #[tokio::test]
    async fn pending_open_can_be_cancelled_by_attempt_id() {
        let attempt_id = "cancel-open-test";
        let (receiver, _guard) = register_open_attempt(attempt_id);
        assert!(ssh_cancel_open(attempt_id.to_string()));
        assert!(receiver.await.is_ok());
    }

    #[tokio::test]
    async fn cancel_before_registration_is_not_lost() {
        let attempt_id = "pre-cancel-open-test";
        assert!(ssh_cancel_open(attempt_id.to_string()));
        let (receiver, _guard) = register_open_attempt(attempt_id);
        assert!(receiver.await.is_ok());
    }
}
