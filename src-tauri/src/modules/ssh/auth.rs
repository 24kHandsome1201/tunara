// SSH authentication chain: ssh-agent → key file → password.
//
// Tunara stores NO credentials. Auth is delegated to the system: the
// ssh-agent (if reachable), an on-disk private key, or a password the user
// types for this connection only (never persisted).
//
// macOS gotcha: GUI apps inherit a different environment than the login shell,
// so `SSH_AUTH_SOCK` is often unset and `AgentClient::connect_env()` fails.
// We try `connect_env` first, and surface a clear "agent unreachable" so the
// caller can fall back to key/password instead of hanging.

use std::path::Path;
use std::sync::Arc;

use russh::client::{AuthResult, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};

use super::connection::ClientHandler;

/// How the caller wants to authenticate. Built from the host profile +
/// any password the user typed for this attempt.
pub struct AuthOptions {
    pub user: String,
    /// Path to a private key file (e.g. ~/.ssh/id_ed25519). If `None`, agent
    /// and password are still attempted.
    pub identity_file: Option<String>,
    /// Passphrase for an encrypted key file, if needed.
    pub key_passphrase: Option<String>,
    /// Password for password auth, if the user provided one.
    pub password: Option<String>,
}

/// Run the auth chain against an already-connected handle. Returns Ok(()) on
/// success, Err(message) describing why every method failed.
pub async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    opts: &AuthOptions,
) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    // 1) ssh-agent (covers 1Password / Secretive / keychain-backed keys).
    match try_agent(handle, &opts.user).await {
        Ok(true) => return Ok(()),
        Ok(false) => errors.push("agent: no offered key accepted".into()),
        Err(e) => errors.push(format!("agent: {e}")),
    }

    // 2) explicit identity file.
    if let Some(path) = &opts.identity_file {
        match try_key_file(handle, &opts.user, path, opts.key_passphrase.as_deref()).await {
            Ok(true) => return Ok(()),
            Ok(false) => errors.push(format!("key {path}: rejected")),
            Err(e) => errors.push(format!("key {path}: {e}")),
        }
    }

    // 3) password (only if the user supplied one — we never store it).
    if let Some(pw) = &opts.password {
        match handle.authenticate_password(&opts.user, pw).await {
            Ok(r) if r.success() => return Ok(()),
            Ok(_) => errors.push("password: rejected".into()),
            Err(e) => errors.push(format!("password: {e}")),
        }
    }

    Err(format!("authentication failed ({})", errors.join("; ")))
}

async fn try_agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<bool, String> {
    // connect_env reads $SSH_AUTH_SOCK; on macOS GUI launches this is often
    // unset — treat that as "no agent" rather than a hard error.
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| format!("no reachable agent ({e})"))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| e.to_string())?;
    if identities.is_empty() {
        return Ok(false);
    }
    // Prefer SHA-2 RSA; for non-RSA keys hash_alg is ignored. Outer Option =
    // "server told us its sig algs", inner = "which hash" — flatten both.
    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    for identity in identities {
        // We sign through the agent, but auth still needs the public key.
        let pubkey = match &identity {
            AgentIdentity::PublicKey { key, .. } => key.clone(),
            // Certificate-based agent identities aren't handled in Phase 1.
            AgentIdentity::Certificate { .. } => continue,
        };
        match handle
            .authenticate_publickey_with(user, pubkey, hash_alg, &mut agent)
            .await
        {
            Ok(r) if r.success() => return Ok(true),
            Ok(_) => continue,
            Err(e) => log::debug!("agent key auth error: {e}"),
        }
    }
    Ok(false)
}

async fn try_key_file(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    path: &str,
    passphrase: Option<&str>,
) -> Result<bool, String> {
    let expanded = expand_tilde(path);
    let key = load_secret_key(&expanded, passphrase).map_err(|e| e.to_string())?;
    // For RSA keys, negotiate a SHA-2 hash; plain ssh-rsa (SHA-1) is rejected
    // by modern servers. Double Option as in try_agent.
    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
    let res: AuthResult = handle
        .authenticate_publickey(user, with_hash)
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.success())
}

fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    Path::new(path).to_path_buf()
}
