use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::modules::ssh::auth::AuthMethod;
use crate::modules::ssh::local_safe_write::{self, Revision};

const CONFIG_DIR: &str = "tunara";

/// A saved SSH connection target. `id` is a stable frontend-generated key.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct SshHostProfile {
    pub id: String,
    /// User-facing label; falls back to user@host in the UI when empty.
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_method: Option<AuthMethod>,
    /// Path to a private key (e.g. ~/.ssh/id_ed25519). Used by `Key`, and as
    /// a preferred IdentityFile hint for `Auto`.
    pub identity_file: String,
    /// Optional OpenSSH user certificate paired with `identity_file`.
    pub certificate_file: String,
    /// Optional profile id for a statically resolved, single-hop jump host.
    pub proxy_jump_profile_id: String,
    /// Reopen the terminal automatically after a transport drop.
    pub auto_reconnect: bool,
    /// Skip the remote bash/zsh integration script for this host.
    pub shell_integration_disabled: bool,
    /// Command typed into the shell after each (re)connect, e.g. `herdr`.
    pub post_connect_command: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct HostsFile {
    /// Missing means the legacy v1/direct schema. Reads never rewrite it.
    pub(crate) schema_version: Option<u8>,
    #[serde(rename = "host")]
    pub(crate) hosts: Vec<SshHostProfile>,
}

pub(crate) fn hosts_path() -> Result<PathBuf, String> {
    if let Ok(dir) = env::var("XDG_CONFIG_HOME") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed).join(CONFIG_DIR).join("hosts.toml"));
        }
    }
    // Use dirs::home_dir() (not $HOME) so host profiles resolve to the same
    // home as known_hosts/auth under macOS GUI launch where $HOME may be unset.
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    Ok(home.join(".config").join(CONFIG_DIR).join("hosts.toml"))
}

pub(crate) fn read_hosts_with_revision(
    path: &Path,
) -> Result<(Vec<SshHostProfile>, Revision), String> {
    let bytes = match local_safe_write::read(path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok((Vec::new(), Revision::Missing)),
        Err(local_safe_write::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), Revision::Missing));
        }
        Err(error) => return Err(format!("read hosts failed: {error}")),
    };
    let revision = local_safe_write::revision(&bytes);
    let raw = String::from_utf8(bytes).map_err(|_| "parse hosts failed: file is not UTF-8")?;
    let parsed: HostsFile = toml::from_str(&raw).map_err(|e| format!("parse hosts failed: {e}"))?;
    Ok((parsed.hosts, revision))
}

pub(crate) fn read_hosts(path: &Path) -> Result<Vec<SshHostProfile>, String> {
    read_hosts_with_revision(path).map(|(hosts, _)| hosts)
}

pub(crate) fn write_hosts(
    path: &Path,
    hosts: &[SshHostProfile],
    expected: &Revision,
) -> Result<(), String> {
    local_safe_write::ensure_parent(path)
        .map_err(|error| format!("create config dir failed: {error}"))?;
    let file = HostsFile {
        schema_version: Some(2),
        hosts: hosts.to_vec(),
    };
    let body = toml::to_string_pretty(&file).map_err(|e| format!("serialize hosts failed: {e}"))?;
    local_safe_write::replace(path, body.as_bytes(), expected)
        .map_err(|e| format!("write hosts failed: {e}"))
}

fn hosts_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
pub fn ssh_hosts_load() -> Result<Vec<SshHostProfile>, String> {
    (|| read_hosts(&hosts_path()?))().map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Hosts, error)
    })
}

/// Insert or update a profile (matched by `id`), then persist. Returns the
/// full updated list so the frontend can refresh in one round-trip.
#[tauri::command]
pub fn ssh_hosts_save(mut profile: SshHostProfile) -> Result<Vec<SshHostProfile>, String> {
    (|| {
        if profile.id.trim().is_empty() {
            return Err("profile id is required".into());
        }
        let _guard = hosts_lock()
            .lock()
            .map_err(|_| "hosts persistence lock poisoned")?;
        validate_profile_auth_paths(&mut profile)?;
        let path = hosts_path()?;
        let (mut hosts, revision) = read_hosts_with_revision(&path)?;
        match hosts.iter_mut().find(|h| h.id == profile.id) {
            Some(existing) => *existing = profile,
            None => hosts.push(profile),
        }
        write_hosts(&path, &hosts, &revision)?;
        Ok(hosts)
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Hosts, error)
    })
}

pub(crate) fn validate_profile_auth_paths(profile: &mut SshHostProfile) -> Result<(), String> {
    if profile.auth_method.is_some()
        && profile.auth_method != Some(AuthMethod::Key)
        && profile.auth_method != Some(AuthMethod::Auto)
    {
        profile.identity_file.clear();
        profile.certificate_file.clear();
        return Ok(());
    }
    for (directive, path) in [
        ("IdentityFile", profile.identity_file.as_str()),
        ("CertificateFile", profile.certificate_file.as_str()),
    ] {
        if path.len() > 4_096 || path.chars().any(char::is_control) {
            return Err(format!("invalid {directive} path"));
        }
        if path.contains("-----BEGIN ") && path.contains(" PRIVATE KEY-----") {
            return Err(format!(
                "{directive} must be a path, not private-key material"
            ));
        }
    }
    if !profile.certificate_file.is_empty()
        && (!matches!(
            profile.auth_method,
            Some(AuthMethod::Key) | Some(AuthMethod::Auto) | None
        ) || profile.identity_file.is_empty())
    {
        return Err(
            "CertificateFile requires key or automatic authentication and IdentityFile".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_hosts_remove(id: String) -> Result<Vec<SshHostProfile>, String> {
    (|| {
        let _guard = hosts_lock()
            .lock()
            .map_err(|_| "hosts persistence lock poisoned")?;
        let path = hosts_path()?;
        let (mut hosts, revision) = read_hosts_with_revision(&path)?;
        hosts.retain(|h| h.id != id);
        write_hosts(&path, &hosts, &revision)?;
        Ok(hosts)
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Hosts, error)
    })
}

// ── ~/.ssh/config import ────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::temp_path;
    use super::*;
    use std::fs;

    #[test]
    fn save_update_remove_roundtrip() {
        let path = temp_path("roundtrip");
        assert!(read_hosts(&path).unwrap().is_empty());

        let p = SshHostProfile {
            id: "h1".into(),
            label: "prod".into(),
            host: "example.com".into(),
            port: 22,
            user: "root".into(),
            auth_method: Some(AuthMethod::Key),
            identity_file: "~/.ssh/id_ed25519".into(),
            certificate_file: "~/.ssh/id_ed25519-cert.pub".into(),
            proxy_jump_profile_id: String::new(),
            ..SshHostProfile::default()
        };
        write_hosts(&path, std::slice::from_ref(&p), &Revision::Missing).unwrap();
        let loaded = read_hosts(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].host, "example.com");
        assert_eq!(loaded[0].port, 22);
        assert_eq!(loaded[0].auth_method, Some(AuthMethod::Key));

        // No secret fields exist on the struct — nothing to leak by construction.
        let body = fs::read_to_string(&path).unwrap();
        assert!(!body.to_lowercase().contains("password"));
        assert!(!body.to_lowercase().contains("passphrase"));

        let (_, stale_revision) = read_hosts_with_revision(&path).unwrap();
        fs::write(&path, body.replace("example.com", "external.example")).unwrap();
        assert!(write_hosts(&path, std::slice::from_ref(&p), &stale_revision).is_err());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("external.example"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn legacy_profile_without_auth_method_remains_compatible() {
        let parsed: HostsFile = toml::from_str(
            "[[host]]\nid = 'old'\nlabel = ''\nhost = 'old.example'\nport = 22\nuser = 'alice'\nidentity_file = ''\n",
        )
        .unwrap();
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!(parsed.hosts[0].auth_method, None);
        assert!(parsed.hosts[0].proxy_jump_profile_id.is_empty());
    }

    #[test]
    fn profile_validation_persists_paths_but_never_key_material() {
        let base = || SshHostProfile {
            id: "certified".into(),
            label: "certified".into(),
            host: "certified.example".into(),
            port: 22,
            user: "alice".into(),
            auth_method: Some(AuthMethod::Key),
            identity_file: "~/.ssh/id_ed25519".into(),
            certificate_file: "~/.ssh/id_ed25519-cert.pub".into(),
            proxy_jump_profile_id: String::new(),
            ..SshHostProfile::default()
        };

        let mut valid = base();
        validate_profile_auth_paths(&mut valid).unwrap();
        assert_eq!(valid.certificate_file, "~/.ssh/id_ed25519-cert.pub");

        let mut dangling = base();
        dangling.identity_file.clear();
        assert!(validate_profile_auth_paths(&mut dangling).is_err());

        let mut key_material = base();
        key_material.identity_file =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----".into();
        assert!(validate_profile_auth_paths(&mut key_material).is_err());

        let mut password = base();
        password.auth_method = Some(AuthMethod::Password);
        validate_profile_auth_paths(&mut password).unwrap();
        assert!(password.identity_file.is_empty());
        assert!(password.certificate_file.is_empty());
    }
}
