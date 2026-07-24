// SSH authentication: a shared "none" probe followed by exactly one
// user-selected method. There is deliberately no cross-method fallback.
//
// Tunara stores NO credentials. Auth is delegated to the system: the
// ssh-agent (if reachable), an on-disk private key, or a password the user
// types for this connection only (never persisted).
//
// macOS gotcha: GUI apps inherit a different environment than the login shell,
// so `SSH_AUTH_SOCK` is often unset. We try the process environment, macOS
// launchd, then well-known 1Password/Secretive sockets, with a short timeout
// per candidate. Agent failures stay agent failures and never trigger an
// implicit key/password attempt.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use super::connection::ClientHandler;
use crate::modules::pty::{KeyboardInteractivePrompt, PtyEvent};

const AGENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IDENTITY_LOAD_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_IDENTITY_FILE_BYTES: u64 = 1024 * 1024;
const KEYBOARD_INTERACTIVE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum AuthMethod {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "key")]
    Key,
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "keyboard-interactive")]
    KeyboardInteractive,
}

/// How the caller wants to authenticate. Built from the explicit UI selection
/// plus any one-shot secret the selected method needs.
pub struct AuthOptions {
    pub user: String,
    pub method: AuthMethod,
    /// Path to a private key file (e.g. ~/.ssh/id_ed25519). Used only by Key.
    pub identity_file: Option<String>,
    /// Passphrase for an encrypted key file, if needed.
    pub key_passphrase: Option<String>,
    /// Password for password auth, if the user provided one.
    pub password: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum SelectedAuth<'a> {
    Agent,
    Key {
        path: &'a str,
        passphrase: Option<&'a str>,
    },
    Password(&'a str),
    KeyboardInteractive,
}

fn selected_auth(opts: &AuthOptions) -> Result<SelectedAuth<'_>, String> {
    match opts.method {
        AuthMethod::Agent => Ok(SelectedAuth::Agent),
        AuthMethod::Key => Ok(SelectedAuth::Key {
            path: opts
                .identity_file
                .as_deref()
                .ok_or("key authentication requires an identity file")?,
            passphrase: opts.key_passphrase.as_deref(),
        }),
        AuthMethod::Password => Ok(SelectedAuth::Password(
            opts.password
                .as_deref()
                .ok_or("password authentication requires a password")?,
        )),
        AuthMethod::KeyboardInteractive => Ok(SelectedAuth::KeyboardInteractive),
    }
}

/// Run only the selected auth method against an already-connected handle.
/// `none` is probed first solely to support credential-free accounts.
pub async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    opts: &AuthOptions,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    // OpenSSH starts with the "none" method both to discover allowed methods
    // and to support intentionally credential-free accounts. A rejection is
    // the normal case and should not pollute the final diagnostic.
    match handle.authenticate_none(&opts.user).await {
        Ok(result) if result.success() => return Ok(()),
        Ok(_) => {}
        Err(error) => log::debug!("SSH none authentication probe failed: {error}"),
    }

    match selected_auth(opts)? {
        SelectedAuth::Agent => match try_agent(handle, &opts.user).await {
            Ok(true) => Ok(()),
            Ok(false) => Err("agent authentication failed: no offered key accepted".into()),
            Err(error) => Err(format!("agent authentication failed: {error}")),
        },
        SelectedAuth::Key { path, passphrase } => {
            match try_key_file(handle, &opts.user, path, passphrase).await {
                Ok(true) => Ok(()),
                Ok(false) => Err("key authentication failed: rejected".into()),
                Err(error) => Err(format!("key authentication failed: {error}")),
            }
        }
        SelectedAuth::Password(password) => {
            let result = handle
                .authenticate_password(&opts.user, password)
                .await
                .map_err(|error| format!("password authentication failed: {error}"))?;
            if result.success() {
                Ok(())
            } else {
                Err(concat!("password authentication failed: ", "rejected").into())
            }
        }
        SelectedAuth::KeyboardInteractive => {
            authenticate_keyboard_interactive(handle, &opts.user, on_event).await
        }
    }
}

type KeyboardResponses = Option<Vec<String>>;
static PENDING_KEYBOARD_PROMPTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, oneshot::Sender<KeyboardResponses>>>,
> = std::sync::OnceLock::new();
static NEXT_KEYBOARD_PROMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn pending_keyboard_prompts(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, oneshot::Sender<KeyboardResponses>>>
{
    PENDING_KEYBOARD_PROMPTS.get_or_init(Default::default)
}

pub fn resolve_keyboard_interactive_prompt(prompt_id: &str, responses: KeyboardResponses) -> bool {
    pending_keyboard_prompts()
        .lock()
        .ok()
        .and_then(|mut prompts| prompts.remove(prompt_id))
        .is_some_and(|sender| sender.send(responses).is_ok())
}

async fn request_keyboard_responses(
    on_event: &Channel<PtyEvent>,
    name: String,
    instructions: String,
    prompts: Vec<russh::client::Prompt>,
) -> Result<Vec<String>, String> {
    let prompt_id = format!(
        "kip-{}",
        NEXT_KEYBOARD_PROMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let expected = prompts.len();
    let (sender, receiver) = oneshot::channel();
    pending_keyboard_prompts()
        .lock()
        .map_err(|_| "keyboard-interactive prompt registry unavailable")?
        .insert(prompt_id.clone(), sender);
    struct PromptGuard(String);
    impl Drop for PromptGuard {
        fn drop(&mut self) {
            if let Ok(mut prompts) = pending_keyboard_prompts().lock() {
                prompts.remove(&self.0);
            }
        }
    }
    let _guard = PromptGuard(prompt_id.clone());
    on_event
        .send(PtyEvent::KeyboardInteractivePrompt {
            prompt_id,
            name,
            instructions,
            prompts: prompts
                .into_iter()
                .map(|p| KeyboardInteractivePrompt {
                    prompt: p.prompt,
                    echo: p.echo,
                })
                .collect(),
        })
        .map_err(|_| "keyboard-interactive prompt delivery failed")?;
    let responses = tokio::time::timeout(KEYBOARD_INTERACTIVE_TIMEOUT, receiver)
        .await
        .map_err(|_| "keyboard-interactive authentication timed out")?
        .map_err(|_| "keyboard-interactive authentication canceled")?
        .ok_or("keyboard-interactive authentication canceled")?;
    if responses.len() != expected {
        return Err(format!(
            "keyboard-interactive response count mismatch: expected {expected}, got {}",
            responses.len()
        ));
    }
    Ok(responses)
}

async fn authenticate_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(|error| format!("keyboard-interactive authentication failed: {error}"))?;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("keyboard-interactive authentication failed: rejected".into())
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let responses =
                    request_keyboard_responses(&on_event, name, instructions, prompts).await?;
                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|error| {
                        format!("keyboard-interactive authentication failed: {error}")
                    })?;
            }
        }
    }
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
    fn auth_method_wire_values_are_explicit() {
        let cases = [
            (AuthMethod::Agent, "\"agent\""),
            (AuthMethod::Key, "\"key\""),
            (AuthMethod::Password, "\"password\""),
            (AuthMethod::KeyboardInteractive, "\"keyboard-interactive\""),
        ];
        for (method, wire) in cases {
            assert_eq!(serde_json::to_string(&method).unwrap(), wire);
            assert_eq!(serde_json::from_str::<AuthMethod>(wire).unwrap(), method);
        }
    }

    #[test]
    fn password_selection_ignores_key_and_agent_inputs() {
        let opts = AuthOptions {
            user: "alice".into(),
            method: AuthMethod::Password,
            identity_file: Some("~/.ssh/should-not-be-read".into()),
            key_passphrase: Some("also-ignored".into()),
            password: Some("one-shot".into()),
        };
        assert_eq!(
            selected_auth(&opts).unwrap(),
            SelectedAuth::Password("one-shot")
        );
    }

    #[test]
    fn each_selected_method_requires_only_its_own_input() {
        let base = || AuthOptions {
            user: "alice".into(),
            method: AuthMethod::Agent,
            identity_file: None,
            key_passphrase: None,
            password: None,
        };
        assert_eq!(selected_auth(&base()).unwrap(), SelectedAuth::Agent);

        let mut key = base();
        key.method = AuthMethod::Key;
        assert!(selected_auth(&key).unwrap_err().contains("identity file"));

        let mut password = base();
        password.method = AuthMethod::Password;
        assert!(selected_auth(&password)
            .unwrap_err()
            .contains("requires a password"));

        let mut interactive = base();
        interactive.method = AuthMethod::KeyboardInteractive;
        assert_eq!(
            selected_auth(&interactive).unwrap(),
            SelectedAuth::KeyboardInteractive
        );
    }

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
