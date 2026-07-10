// SSH authentication chain: none probe → explicit key file → password → ssh-agent.
//
// Tunara stores NO credentials. Auth is delegated to the system: the
// ssh-agent (if reachable), an on-disk private key, or a password the user
// types for this connection only (never persisted).
//
// macOS gotcha: GUI apps inherit a different environment than the login shell,
// so `SSH_AUTH_SOCK` is often unset. We try the process environment, macOS
// launchd, then well-known 1Password/Secretive sockets, with a short timeout
// per candidate. Failure remains non-fatal so the chain can continue to a
// password.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};

use super::connection::ClientHandler;

const AGENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IDENTITY_LOAD_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_IDENTITY_FILE_BYTES: u64 = 1024 * 1024;

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

    // OpenSSH starts with the "none" method both to discover allowed methods
    // and to support intentionally credential-free accounts. A rejection is
    // the normal case and should not pollute the final diagnostic.
    match handle.authenticate_none(&opts.user).await {
        Ok(result) if result.success() => return Ok(()),
        Ok(_) => {}
        Err(error) => errors.push(format!("none: {error}")),
    }

    // 1) An identity selected in the host profile is an explicit user choice.
    // Try it before enumerating agent keys so a large agent cannot consume the
    // server's authentication-attempt budget first.
    if let Some(path) = &opts.identity_file {
        match try_key_file(handle, &opts.user, path, opts.key_passphrase.as_deref()).await {
            Ok(true) => return Ok(()),
            Ok(false) => errors.push(format!("key {path}: rejected")),
            Err(e) => errors.push(format!("key {path}: {e}")),
        }
    }

    // 2) A password supplied for this attempt is another explicit user choice.
    // Try it before enumerating an agent: a large agent can otherwise exhaust
    // the server's MaxAuthTries budget before password auth is attempted.
    if let Some(pw) = &opts.password {
        match handle.authenticate_password(&opts.user, pw).await {
            Ok(r) if r.success() => return Ok(()),
            Ok(_) => errors.push("password: rejected".into()),
            Err(e) => errors.push(format!("password: {e}")),
        }
    }

    // 3) ssh-agent (covers 1Password / Secretive / keychain-backed keys).
    match try_agent(handle, &opts.user).await {
        Ok(true) => return Ok(()),
        Ok(false) => errors.push("agent: no offered key accepted".into()),
        Err(e) => errors.push(format!("agent: {e}")),
    }

    Err(format!("authentication failed ({})", errors.join("; ")))
}

async fn try_agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<bool, String> {
    let mut agent = connect_agent_client().await?;
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

fn push_agent_socket(candidates: &mut Vec<PathBuf>, value: impl AsRef<Path>) {
    let path = value.as_ref();
    if path.is_absolute() && !candidates.iter().any(|candidate| candidate == path) {
        candidates.push(path.to_path_buf());
    }
}

#[cfg(target_os = "macos")]
async fn launchd_agent_socket() -> Option<PathBuf> {
    let output = tokio::time::timeout(
        Duration::from_secs(1),
        tokio::process::Command::new("/bin/launchctl")
            .args(["getenv", "SSH_AUTH_SOCK"])
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(PathBuf::from(value))
}

async fn connect_agent_client() -> Result<AgentClient<tokio::net::UnixStream>, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("SSH_AUTH_SOCK") {
        push_agent_socket(&mut candidates, PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = launchd_agent_socket().await {
        push_agent_socket(&mut candidates, path);
    }
    if let Some(home) = dirs::home_dir() {
        for path in [
            home.join(".1password/agent.sock"),
            home.join("Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh"),
        ] {
            if path.exists() {
                push_agent_socket(&mut candidates, path);
            }
        }
    }

    if candidates.is_empty() {
        return Err("no SSH agent socket found".into());
    }
    let mut errors = Vec::new();
    for path in candidates {
        match tokio::time::timeout(AGENT_CONNECT_TIMEOUT, AgentClient::connect_uds(&path)).await {
            Ok(Ok(agent)) => return Ok(agent),
            Ok(Err(error)) => errors.push(format!("{}: {error}", path.display())),
            Err(_) => errors.push(format!("{}: timed out", path.display())),
        }
    }
    Err(format!("no reachable SSH agent ({})", errors.join("; ")))
}

async fn try_key_file(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    path: &str,
    passphrase: Option<&str>,
) -> Result<bool, String> {
    let expanded = expand_tilde(path);
    let key = load_identity_file(expanded, passphrase.map(str::to_owned)).await?;
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

async fn load_identity_file(
    path: PathBuf,
    passphrase: Option<String>,
) -> Result<russh::keys::PrivateKey, String> {
    let metadata = tokio::time::timeout(IDENTITY_LOAD_TIMEOUT, tokio::fs::metadata(&path))
        .await
        .map_err(|_| format!("identity metadata timed out: {}", path.display()))?
        .map_err(|error| format!("cannot read identity metadata {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "identity is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_IDENTITY_FILE_BYTES {
        return Err(format!(
            "identity file is too large ({} bytes, limit {}): {}",
            metadata.len(),
            MAX_IDENTITY_FILE_BYTES,
            path.display()
        ));
    }

    let display = path.display().to_string();
    let task = tokio::task::spawn_blocking(move || {
        load_secret_key(&path, passphrase.as_deref()).map_err(|error| error.to_string())
    });
    tokio::time::timeout(IDENTITY_LOAD_TIMEOUT, task)
        .await
        .map_err(|_| format!("identity loading timed out: {display}"))?
        .map_err(|error| format!("identity loader failed for {display}: {error}"))?
}

// Expand a leading `~` against the user's home. Uses `dirs::home_dir()` (not
// $HOME) so it works under macOS GUI launch where $HOME may be unset — the same
// resolution known_hosts and host profiles use, keeping all SSH paths
// consistent. Delegates the core expansion to `util::expand_tilde_with` so the
// tilde-parsing logic has a single source of truth; only the home source
// differs from the local-fs `util::expand_tilde` (which is `$HOME`-based).
fn expand_tilde(path: &str) -> std::path::PathBuf {
    crate::modules::util::expand_tilde_with(path, dirs::home_dir().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn expand_tilde_handles_bare_and_prefixed() {
        let home = dirs::home_dir().expect("home dir in test env");
        // Bare "~" must expand to home, not pass through literally (the bug
        // this fix closes — an identity_file of "~" previously became "~").
        assert_eq!(expand_tilde("~"), home);
        // "~/x" expands under home.
        assert_eq!(
            expand_tilde("~/.ssh/id_ed25519"),
            home.join(".ssh/id_ed25519")
        );
        // Non-tilde paths pass through unchanged.
        assert_eq!(
            expand_tilde("/etc/key"),
            Path::new("/etc/key").to_path_buf()
        );
        // A tilde not at the start is not expanded.
        assert_eq!(expand_tilde("/a/~/b"), Path::new("/a/~/b").to_path_buf());
    }

    #[test]
    fn agent_socket_candidates_are_absolute_and_deduplicated() {
        let mut candidates = Vec::new();
        push_agent_socket(&mut candidates, "/tmp/agent.sock");
        push_agent_socket(&mut candidates, "/tmp/agent.sock");
        push_agent_socket(&mut candidates, "relative.sock");
        assert_eq!(candidates, vec![PathBuf::from("/tmp/agent.sock")]);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn launchd_agent_socket_is_absolute_when_exported() {
        if let Some(path) = launchd_agent_socket().await {
            assert!(path.is_absolute());
        }
    }

    #[tokio::test]
    async fn identity_loader_rejects_directories_and_oversized_files() {
        let directory = std::env::temp_dir();
        let directory_error = load_identity_file(directory, None).await.unwrap_err();
        assert!(directory_error.contains("not a regular file"));

        let path = std::env::temp_dir().join(format!(
            "tunara-oversized-identity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::write(&path, vec![0_u8; MAX_IDENTITY_FILE_BYTES as usize + 1])
            .await
            .unwrap();
        let error = load_identity_file(path.clone(), None).await.unwrap_err();
        assert!(error.contains("identity file is too large"));
        tokio::fs::remove_file(path).await.unwrap();
    }
}
