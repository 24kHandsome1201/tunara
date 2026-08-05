//! Shared SFTP primitives. Browse/write commands and legacy transfers use this
//! seam rather than duplicating PTY/session discrimination.

use crate::modules::pty::{PtyState, Session};

use super::diagnostics::SessionBindingV1;

pub async fn session(
    state: &PtyState,
    id: u32,
) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    match session.as_ref() {
        Session::Ssh(ssh) => ssh.sftp().await,
        Session::Local(_) => Err("not a remote session".into()),
    }
}

/// Validate the complete backend-issued binding before opening/reusing SFTP.
/// Callers using v2 contracts must use this instead of trusting a bare PTY id.
#[allow(dead_code)] // public seam consumed by flows C/D after rebasing A0
pub async fn session_for_binding(
    state: &PtyState,
    binding: &SessionBindingV1,
) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
    let session = state
        .get_for_ssh_binding(binding)
        .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
    match session.as_ref() {
        Session::Ssh(ssh) => ssh.sftp().await,
        Session::Local(_) => Err("not a remote session".into()),
    }
}
