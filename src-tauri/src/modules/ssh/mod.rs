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

use auth::{AuthMethod, AuthOptions};
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
    latest_pending_by_logical: HashMap<String, (String, u64)>,
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
            state.cancelled.remove(&self.open_attempt_id);
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
        state.cancelled.remove(&self.open_attempt_id);
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
        if state.cancelled.remove(open_attempt_id) {
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
    on_event: Channel<PtyEvent>,
    open_attempt_id: &str,
) -> Result<(SshSession, OpenAttemptGuard), String> {
    let logical_session_id = (!params.session_id.is_empty()).then_some(params.session_id.as_str());
    let (cancel, guard) = register_open_attempt(open_attempt_id, logical_session_id);
    let ssh = tokio::select! {
        result = SshSession::open(params, on_event) => result,
        _ = cancel => Err("SSH connection canceled".to_string()),
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
            method: auth_method.ok_or("SSH authentication method is required")?,
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

    let (ssh, open_attempt) = open_with_cancellation(params, on_event, &open_attempt_id)
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
    let (id, replaced_id) = open_attempt.publish_if_current(|| {
        let replaced_id = logical_session_id
            .as_deref()
            .and_then(|logical_id| state.physical_for_logical(logical_id));
        let id = state.insert(
            std::sync::Arc::new(Session::Ssh(ssh)),
            logical_session_id.as_deref(),
        );
        (id, replaced_id)
    })?;
    // Window/UI work stays outside OPEN_ATTEMPTS. `replaced_id` was captured
    // in the same publication critical section, so this cannot target a newer
    // connection even if another reconnect starts immediately afterwards.
    if let Some(old_id) = replaced_id {
        preview_state.close_tunnels_for_pty(&app, old_id);
    }
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

#[tauri::command]
pub fn ssh_keyboard_interactive_response(
    prompt_id: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    if auth::resolve_keyboard_interactive_prompt(&prompt_id, responses) {
        Ok(())
    } else {
        Err("keyboard-interactive prompt no longer pending".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_pending_open_for_logical, register_open_attempt, ssh_cancel_open,
        validate_open_input,
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
