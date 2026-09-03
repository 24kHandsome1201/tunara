// SSH authentication: a shared "none" probe, then either one explicit method
// or the `auto` chain (agent → config/default keys → password/k-i).
//
// Explicit methods never fall across types. `auto` stays on one TCP session
// and stops publickey attempts once the server drops that method, so a typical
// OpenSSH MaxAuthTries budget is not exhausted by missing files.
//
// Tunara stores NO credentials. Secrets are one-shot in memory. Encrypted
// private keys and server password/k-i prompts reuse the keyboard-interactive
// channel so the first-run UI does not need a password field.
//
// macOS gotcha: GUI apps inherit a different environment than the login shell,
// so `SSH_AUTH_SOCK` is often unset. We try the process environment, macOS
// launchd, then well-known 1Password/Secretive sockets, with a short timeout
// per candidate.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
#[cfg(unix)]
use russh::keys::agent::client::AgentClient;
#[cfg(unix)]
use russh::keys::agent::AgentIdentity;
use russh::keys::{load_openssh_certificate, load_secret_key, Algorithm, PrivateKeyWithHashAlg};
use russh::{MethodKind, MethodSet};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

use super::connection::ClientHandler;
use crate::modules::pty::{KeyboardInteractiveOrigin, KeyboardInteractivePrompt, PtyEvent};

#[cfg(unix)]
const AGENT_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const IDENTITY_LOAD_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_IDENTITY_FILE_BYTES: u64 = 1024 * 1024;
const KEYBOARD_INTERACTIVE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum AuthMethod {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "key")]
    Key,
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "keyboard-interactive")]
    KeyboardInteractive,
}

/// How the caller wants to authenticate. Built from the UI selection plus any
/// one-shot secret the selected method needs. `Auto` may also use IdentityFile
/// as a preferred key hint.
pub struct AuthOptions {
    pub user: String,
    pub method: AuthMethod,
    /// Path to a private key file (e.g. ~/.ssh/id_ed25519). Used by Key, and as
    /// a preferred IdentityFile hint for Auto.
    pub identity_file: Option<String>,
    /// Optional OpenSSH user certificate paired with `identity_file`.
    pub certificate_file: Option<String>,
    /// Passphrase for an encrypted key file, if needed.
    pub key_passphrase: Option<String>,
    /// Password for password auth, if the user provided one.
    pub password: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum SelectedAuth<'a> {
    Auto,
    Agent,
    Key {
        path: &'a str,
        certificate: Option<&'a str>,
        passphrase: Option<&'a str>,
    },
    Password(&'a str),
    KeyboardInteractive,
}

fn selected_auth(opts: &AuthOptions) -> Result<SelectedAuth<'_>, String> {
    match opts.method {
        AuthMethod::Auto => Ok(SelectedAuth::Auto),
        AuthMethod::Agent => Ok(SelectedAuth::Agent),
        AuthMethod::Key => Ok(SelectedAuth::Key {
            path: opts
                .identity_file
                .as_deref()
                .ok_or("key authentication requires an identity file")?,
            certificate: opts.certificate_file.as_deref(),
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

/// Run the selected auth method against an already-connected handle.
/// `none` is probed first solely to support credential-free accounts.
pub async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    opts: &AuthOptions,
    on_event: Channel<PtyEvent>,
    origin: KeyboardInteractiveOrigin,
) -> Result<(), String> {
    // OpenSSH starts with the "none" method both to discover allowed methods
    // and to support intentionally credential-free accounts. A rejection is
    // the normal case and should not pollute the final diagnostic.
    let remaining = match handle.authenticate_none(&opts.user).await {
        Ok(result) if result.success() => return Ok(()),
        Ok(AuthResult::Failure {
            remaining_methods, ..
        }) => remaining_methods,
        Ok(_) => MethodSet::empty(),
        Err(_) => {
            log::debug!("SSH none authentication probe failed");
            MethodSet::empty()
        }
    };

    match selected_auth(opts)? {
        SelectedAuth::Auto => authenticate_auto(handle, opts, remaining, on_event, origin).await,
        SelectedAuth::Agent => match try_agent(handle, &opts.user).await {
            Ok(true) => Ok(()),
            Ok(false) => Err("agent authentication failed: no offered key accepted".into()),
            Err(error) => Err(format!("agent authentication failed: {error}")),
        },
        SelectedAuth::Key {
            path,
            certificate,
            passphrase,
        } => {
            match try_key_file(
                handle,
                &opts.user,
                path,
                certificate,
                passphrase,
                Some((&on_event, &origin)),
            )
            .await
            {
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
            authenticate_keyboard_interactive(handle, &opts.user, on_event, origin).await
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
    origin: KeyboardInteractiveOrigin,
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
            origin,
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
    origin: KeyboardInteractiveOrigin,
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
                let responses = request_keyboard_responses(
                    &on_event,
                    name,
                    instructions,
                    prompts,
                    origin.clone(),
                )
                .await?;
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

const DEFAULT_IDENTITY_FILES: &[&str] = &["~/.ssh/id_ed25519", "~/.ssh/id_ecdsa", "~/.ssh/id_rsa"];
const MAX_AUTO_AUTH_ATTEMPTS: usize = 5;

fn remaining_allows(remaining: &MethodSet, kind: MethodKind) -> bool {
    remaining.is_empty() || remaining.contains(&kind)
}

fn update_remaining(remaining: &mut MethodSet, result: AuthResult) -> bool {
    match result {
        AuthResult::Success => true,
        AuthResult::Failure {
            remaining_methods, ..
        } => {
            *remaining = remaining_methods;
            false
        }
    }
}

fn identity_candidates(opts: &AuthOptions) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<(String, Option<String>)>, path: &str, certificate: Option<&str>| {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return;
        }
        if out.iter().any(|(existing, _)| existing == trimmed) {
            return;
        }
        out.push((
            trimmed.to_string(),
            certificate
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        ));
    };
    if let Some(path) = opts.identity_file.as_deref() {
        push(&mut out, path, opts.certificate_file.as_deref());
    }
    for path in DEFAULT_IDENTITY_FILES {
        push(&mut out, path, None);
    }
    out
}

fn summarize_auto_attempts(attempts: &[String]) -> String {
    if attempts.is_empty() {
        "automatic authentication failed: no methods were attempted".into()
    } else {
        format!("automatic authentication failed: {}", attempts.join("; "))
    }
}

async fn authenticate_auto(
    handle: &mut Handle<ClientHandler>,
    opts: &AuthOptions,
    mut remaining: MethodSet,
    on_event: Channel<PtyEvent>,
    origin: KeyboardInteractiveOrigin,
) -> Result<(), String> {
    let mut attempts = Vec::new();
    let mut spent = 0usize;
    let spend = |spent: &mut usize, attempts: &mut Vec<String>, label: String| -> bool {
        *spent += 1;
        attempts.push(label);
        *spent >= MAX_AUTO_AUTH_ATTEMPTS
    };

    if remaining_allows(&remaining, MethodKind::PublicKey) {
        match try_agent(handle, &opts.user).await {
            Ok(true) => return Ok(()),
            Ok(false) => {
                if spend(
                    &mut spent,
                    &mut attempts,
                    "SSH agent: no offered key accepted".into(),
                ) {
                    return Err(summarize_auto_attempts(&attempts));
                }
            }
            Err(error) => {
                attempts.push(format!("SSH agent: {error}"));
            }
        }
        for (path, certificate) in identity_candidates(opts) {
            if !remaining_allows(&remaining, MethodKind::PublicKey) {
                attempts.push("public-key authentication is no longer offered".into());
                break;
            }
            match try_key_file(
                handle,
                &opts.user,
                &path,
                certificate.as_deref(),
                opts.key_passphrase.as_deref(),
                Some((&on_event, &origin)),
            )
            .await
            {
                Ok(true) => return Ok(()),
                Ok(false) => {
                    if spend(&mut spent, &mut attempts, format!("key {path}: rejected")) {
                        return Err(summarize_auto_attempts(&attempts));
                    }
                }
                Err(error) => {
                    attempts.push(format!("key {path}: {error}"));
                }
            }
        }
    } else {
        attempts.push("server did not offer public-key authentication".into());
    }

    if remaining_allows(&remaining, MethodKind::Password) {
        let prompted = if opts
            .password
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        {
            None
        } else {
            match prompt_password(&on_event, &origin, &opts.user).await {
                Ok(value) => Some(value),
                Err(error) => {
                    attempts.push(format!("password: {error}"));
                    None
                }
            }
        };
        if let Some(password) = prompted
            .as_deref()
            .or(opts.password.as_deref().filter(|value| !value.is_empty()))
        {
            let result = handle
                .authenticate_password(&opts.user, password)
                .await
                .map_err(|error| format!("automatic authentication failed: password: {error}"))?;
            if update_remaining(&mut remaining, result) {
                return Ok(());
            }
            if spend(&mut spent, &mut attempts, "password: rejected".into()) {
                return Err(summarize_auto_attempts(&attempts));
            }
        }
    }

    if remaining_allows(&remaining, MethodKind::KeyboardInteractive) {
        match authenticate_keyboard_interactive(handle, &opts.user, on_event, origin).await {
            Ok(()) => return Ok(()),
            Err(error) => attempts.push(error),
        }
    } else if !remaining_allows(&remaining, MethodKind::Password) {
        attempts.push("server did not offer password or keyboard-interactive login".into());
    }

    Err(summarize_auto_attempts(&attempts))
}

fn looks_like_encrypted_key_error(error: &str) -> bool {
    let lowered = error.to_ascii_lowercase();
    lowered.contains("passphrase") || lowered.contains("encrypted") || lowered.contains("password")
}

async fn prompt_password(
    on_event: &Channel<PtyEvent>,
    origin: &KeyboardInteractiveOrigin,
    user: &str,
) -> Result<String, String> {
    let responses = request_keyboard_responses(
        on_event,
        "Password".into(),
        format!("Password for {user}. It is used once and never saved."),
        vec![russh::client::Prompt {
            prompt: "Password: ".into(),
            echo: false,
        }],
        origin.clone(),
    )
    .await?;
    responses
        .into_iter()
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "password prompt canceled".into())
}

async fn prompt_key_passphrase(
    on_event: &Channel<PtyEvent>,
    origin: &KeyboardInteractiveOrigin,
    path: &str,
) -> Result<String, String> {
    let responses = request_keyboard_responses(
        on_event,
        "Private key passphrase".into(),
        format!("Enter the passphrase for {path}. It is used once and never saved."),
        vec![russh::client::Prompt {
            prompt: "Passphrase: ".into(),
            echo: false,
        }],
        origin.clone(),
    )
    .await?;
    responses
        .into_iter()
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "key passphrase prompt canceled".into())
}

async fn try_agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<bool, String> {
    #[cfg(windows)]
    {
        // B3 intentionally has no native Pageant/named-pipe, CTAP/HID, or
        // PKCS#11 transport. Windows hardware keys require a future supported
        // agent adapter; never fall back to reading a hardware-key stub file.
        let _ = (handle, user);
        return Err("SSH agent authentication is not available on Windows in this build".into());
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (handle, user);
        return Err("SSH agent authentication is unsupported on this platform".into());
    }
    #[cfg(unix)]
    {
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
            // AgentIdentity::Certificate preserves the certificate on the wire;
            // reducing it to its underlying public key would silently lose the CA
            // authorization. Hardware/FIDO/smart-card signing remains agent-only.
            let result = match identity {
                AgentIdentity::PublicKey { key, .. } => {
                    handle
                        .authenticate_publickey_with(user, key, hash_alg, &mut agent)
                        .await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    handle
                        .authenticate_certificate_with(user, certificate, hash_alg, &mut agent)
                        .await
                }
            };
            match result {
                Ok(r) if r.success() => return Ok(true),
                Ok(_) => continue,
                Err(e) => log::debug!("agent key auth error: {e}"),
            }
        }
        Ok(false)
    }
}

#[cfg(unix)]
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

/// macOS and Linux use Unix-domain SSH_AUTH_SOCK agents. Hardware-backed keys
/// are supported only when such an agent exposes them; Tunara does not open
/// CTAP/HID devices or PKCS#11 providers itself.
#[cfg(unix)]
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
    certificate_path: Option<&str>,
    passphrase: Option<&str>,
    prompt: Option<(&Channel<PtyEvent>, &KeyboardInteractiveOrigin)>,
) -> Result<bool, String> {
    let expanded = expand_tilde(path);
    let key = match load_identity_file(expanded.clone(), passphrase.map(str::to_owned)).await {
        Ok(key) => key,
        Err(error)
            if passphrase.is_none()
                && prompt.is_some()
                && looks_like_encrypted_key_error(&error) =>
        {
            let (on_event, origin) = prompt.expect("prompt present");
            let unlocked = prompt_key_passphrase(on_event, origin, path).await?;
            load_identity_file(expanded, Some(unlocked)).await?
        }
        Err(error) => return Err(error),
    };
    if let Some(certificate_path) = certificate_path {
        let certificate = load_certificate_file(expand_tilde(certificate_path)).await?;
        if key.public_key().key_data() != certificate.public_key() {
            return Err("certificate does not match the selected identity file".into());
        }
        if certificate.cert_type() != russh::keys::ssh_key::certificate::CertType::User {
            return Err("certificate file is not an OpenSSH user certificate".into());
        }
        let result = handle
            .authenticate_openssh_cert(user, Arc::new(key), certificate)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(result.success());
    }
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

async fn load_certificate_file(path: PathBuf) -> Result<russh::keys::Certificate, String> {
    let metadata = tokio::time::timeout(IDENTITY_LOAD_TIMEOUT, tokio::fs::metadata(&path))
        .await
        .map_err(|_| format!("certificate metadata timed out: {}", path.display()))?
        .map_err(|error| {
            format!(
                "cannot read certificate metadata {}: {error}",
                path.display()
            )
        })?;
    if !metadata.is_file() {
        return Err(format!(
            "certificate is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() > MAX_IDENTITY_FILE_BYTES {
        return Err(format!(
            "certificate file is too large ({} bytes, limit {}): {}",
            metadata.len(),
            MAX_IDENTITY_FILE_BYTES,
            path.display()
        ));
    }
    let display = path.display().to_string();
    let task = tokio::task::spawn_blocking(move || {
        load_openssh_certificate(&path).map_err(|error| error.to_string())
    });
    tokio::time::timeout(IDENTITY_LOAD_TIMEOUT, task)
        .await
        .map_err(|_| format!("certificate loading timed out: {display}"))?
        .map_err(|error| format!("certificate loader failed for {display}: {error}"))?
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
    let key = tokio::time::timeout(IDENTITY_LOAD_TIMEOUT, task)
        .await
        .map_err(|_| format!("identity loading timed out: {display}"))?
        .map_err(|error| format!("identity loader failed for {display}: {error}"))??;
    if matches!(
        key.algorithm(),
        Algorithm::SkEd25519 | Algorithm::SkEcdsaSha2NistP256
    ) {
        return Err("hardware-backed OpenSSH keys are supported only through an SSH agent".into());
    }
    Ok(key)
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
            (AuthMethod::Auto, "\"auto\""),
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
            certificate_file: Some("~/.ssh/should-not-be-read-cert.pub".into()),
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
            certificate_file: None,
            key_passphrase: None,
            password: None,
        };
        assert_eq!(selected_auth(&base()).unwrap(), SelectedAuth::Agent);

        let mut automatic = base();
        automatic.method = AuthMethod::Auto;
        assert_eq!(selected_auth(&automatic).unwrap(), SelectedAuth::Auto);

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
    fn auto_identity_candidates_prefer_config_then_defaults() {
        let opts = AuthOptions {
            user: "alice".into(),
            method: AuthMethod::Auto,
            identity_file: Some(" ~/.ssh/id_prod ".into()),
            certificate_file: Some(" ~/.ssh/id_prod-cert.pub ".into()),
            key_passphrase: None,
            password: None,
        };
        assert_eq!(
            identity_candidates(&opts),
            vec![
                (
                    "~/.ssh/id_prod".into(),
                    Some("~/.ssh/id_prod-cert.pub".into())
                ),
                ("~/.ssh/id_ed25519".into(), None),
                ("~/.ssh/id_ecdsa".into(), None),
                ("~/.ssh/id_rsa".into(), None),
            ]
        );
    }

    #[test]
    fn auto_failure_lists_each_attempt() {
        let message = summarize_auto_attempts(&[
            "SSH agent: no offered key accepted".into(),
            "key ~/.ssh/id_ed25519: rejected".into(),
            "server did not offer password or keyboard-interactive login".into(),
        ]);
        assert!(message.starts_with("automatic authentication failed:"));
        assert!(message.contains("SSH agent"));
        assert!(message.contains("id_ed25519"));
        assert!(message.contains("password or keyboard-interactive"));
    }

    #[test]
    fn remaining_allows_unknown_probe_as_unrestricted() {
        assert!(remaining_allows(&MethodSet::empty(), MethodKind::PublicKey));
        let methods = [MethodKind::Password];
        let password_only = MethodSet::from(methods.as_slice());
        assert!(remaining_allows(&password_only, MethodKind::Password));
        assert!(!remaining_allows(&password_only, MethodKind::PublicKey));
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

    #[cfg(unix)]
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
