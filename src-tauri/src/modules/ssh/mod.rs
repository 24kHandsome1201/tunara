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
pub mod sftp;

use auth::AuthOptions;
use connection::{ConnectParams, HostKeyPolicy, SshSession};

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
        policy: HostKeyPolicy {
            accept_unknown: accept_unknown_host_key.unwrap_or(true),
        },
        cols,
        rows,
        inject_shell_integration: inject_shell_integration.unwrap_or(false),
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
