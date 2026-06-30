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
pub mod hosts;
pub mod known_hosts;
pub mod remote_git;
pub mod sftp;

use auth::AuthOptions;
use connection::{ConnectParams, HostKeyPolicy, SshSession};

use crate::modules::agent::{hooks::HookListenerState, wrapper};
use crate::modules::pty::{PtyEvent, PtyState, Session};
use tauri::ipc::Channel;

/// Open an SSH session and register it in `PtyState` under a fresh id, exactly
/// like `pty_open` does for local shells. The frontend then drives it through
/// the same pty_write/resize/close commands.
// Flat args map 1:1 to the JS `invoke("ssh_open", {...})` payload — a Tauri
// command can't take a struct here without changing the frontend contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_open(
    state: tauri::State<'_, PtyState>,
    hooks_state: tauri::State<'_, HookListenerState>,
    logical_session_id: Option<String>,
    host: String,
    port: Option<u16>,
    user: String,
    identity_file: Option<String>,
    key_passphrase: Option<String>,
    password: Option<String>,
    accept_unknown_host_key: Option<bool>,
    inject_shell_integration: Option<bool>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> Result<u32, String> {
    // Replace any prior session bound to the same logical id (reopen path).
    if let Some(logical_id) = logical_session_id.as_deref() {
        state.remove_logical(logical_id);
        wrapper::cleanup_hooks_settings(logical_id, hooks_state.agent_config_dir());
    }

    let params = ConnectParams {
        host: host.clone(),
        port: port.unwrap_or(22),
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

    let ssh = SshSession::open(params, on_event).await.map_err(|e| {
        log::error!("ssh_open failed: {e}");
        e
    })?;

    let id = state.insert(Session::Ssh(ssh), logical_session_id.as_deref());
    match logical_session_id {
        Some(lid) => log::info!("ssh opened id={id} host={host} logical_session_id={lid}"),
        None => log::info!("ssh opened id={id} host={host}"),
    }
    Ok(id)
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
