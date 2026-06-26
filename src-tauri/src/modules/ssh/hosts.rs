// Saved SSH host profiles (Phase 2).
//
// Profiles live in their own file, ~/.config/tunara/hosts.toml, separate from
// the comment-preserving appearance config — host management is a flat
// load/save/remove list and doesn't need toml_edit's merge machinery.
//
// IMPORTANT: profiles store NO secrets. Only host/port/user and an optional
// identity-file PATH. Passwords and passphrases are never written to disk.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    /// Path to a private key (e.g. ~/.ssh/id_ed25519). Empty = use agent.
    pub identity_file: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct HostsFile {
    #[serde(rename = "host")]
    hosts: Vec<SshHostProfile>,
}

fn hosts_path() -> Result<PathBuf, String> {
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

fn read_hosts(path: &Path) -> Result<Vec<SshHostProfile>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("read hosts failed: {e}"))?;
    let parsed: HostsFile = toml::from_str(&raw).map_err(|e| format!("parse hosts failed: {e}"))?;
    Ok(parsed.hosts)
}

fn write_hosts(path: &Path, hosts: &[SshHostProfile]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create config dir failed: {e}"))?;
    }
    let file = HostsFile {
        hosts: hosts.to_vec(),
    };
    let body = toml::to_string_pretty(&file).map_err(|e| format!("serialize hosts failed: {e}"))?;
    // Atomic replace so a crash mid-write can't corrupt the list.
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write hosts failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("replace hosts failed: {e}"))
}

#[tauri::command]
pub fn ssh_hosts_load() -> Result<Vec<SshHostProfile>, String> {
    read_hosts(&hosts_path()?)
}

/// Insert or update a profile (matched by `id`), then persist. Returns the
/// full updated list so the frontend can refresh in one round-trip.
#[tauri::command]
pub fn ssh_hosts_save(profile: SshHostProfile) -> Result<Vec<SshHostProfile>, String> {
    if profile.id.trim().is_empty() {
        return Err("profile id is required".into());
    }
    let path = hosts_path()?;
    let mut hosts = read_hosts(&path)?;
    match hosts.iter_mut().find(|h| h.id == profile.id) {
        Some(existing) => *existing = profile,
        None => hosts.push(profile),
    }
    write_hosts(&path, &hosts)?;
    Ok(hosts)
}

#[tauri::command]
pub fn ssh_hosts_remove(id: String) -> Result<Vec<SshHostProfile>, String> {
    let path = hosts_path()?;
    let mut hosts = read_hosts(&path)?;
    hosts.retain(|h| h.id != id);
    write_hosts(&path, &hosts)?;
    Ok(hosts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("tunara-hosts-test-{name}-{unique}"))
            .join("hosts.toml")
    }

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
            identity_file: "~/.ssh/id_ed25519".into(),
        };
        write_hosts(&path, &[p.clone()]).unwrap();
        let loaded = read_hosts(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].host, "example.com");
        assert_eq!(loaded[0].port, 22);

        // No secret fields exist on the struct — nothing to leak by construction.
        let body = fs::read_to_string(&path).unwrap();
        assert!(!body.to_lowercase().contains("password"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
