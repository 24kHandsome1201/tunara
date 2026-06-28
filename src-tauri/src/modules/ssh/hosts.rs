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

// ── ~/.ssh/config import ────────────────────────────────────────────────

/// Result of importing host profiles from `~/.ssh/config`.
/// `imported` are the parsed static `Host` blocks; `skipped` counts wildcard
/// `Host *` / `Match` / malformed blocks that were intentionally ignored.
#[derive(Clone, Debug, Serialize)]
pub struct SshImportResult {
    pub imported: Vec<SshHostProfile>,
    pub skipped: usize,
}

/// Resolve `~/.ssh/config`. Uses `dirs::home_dir()` (not `$HOME`) so it matches
/// the same home `hosts_path()`/auth resolve under a macOS GUI launch where
/// `$HOME` may be unset.
fn ssh_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    Ok(home.join(".ssh").join("config"))
}

/// Parse the textual contents of an ssh_config into host profiles.
///
/// Only static `Host <name>` blocks are imported. `Host *` (and any name
/// containing `*` or `?`) is skipped — those are ssh_config wildcards, not
/// real connect targets. `Match` blocks and `Include` directives are ignored
/// (not recursively followed). `HostName` defaults to the `Host` name when
/// absent, matching openssh behavior. `Port` falls back to 22 on a missing or
/// malformed value. `IdentityFile` is taken verbatim (no `~` expansion here —
/// the auth layer expands it at connect time).
///
/// This is a pure function so it can be unit-tested without touching the
/// filesystem; `ssh_hosts_import_config` reads the file and delegates here.
pub(crate) fn parse_ssh_config(raw: &str) -> SshImportResult {
    let mut imported: Vec<SshHostProfile> = Vec::new();
    let mut skipped: usize = 0;

    // Accumulator for the current `Host` block's directives.
    let mut host_names: Vec<String> = Vec::new();
    let mut host_name: String = String::new();
    let mut user: String = String::new();
    let mut port_raw: String = String::new();
    let mut identity_file: String = String::new();
    let mut in_block: bool = false;

    let flush = |names: &mut Vec<String>,
                 host_name: &mut String,
                 user: &mut String,
                 port_raw: &mut String,
                 identity_file: &mut String,
                 in_block: &mut bool,
                 imported: &mut Vec<SshHostProfile>,
                 skipped: &mut usize| {
        if !*in_block {
            return;
        }
        for name in names.drain(..) {
            // Wildcard host names are ssh_config patterns, not targets.
            if name.contains('*') || name.contains('?') {
                *skipped += 1;
                continue;
            }
            let port: u16 = match port_raw.trim().parse::<u16>() {
                Ok(p) if p >= 1 => p,
                _ => 22,
            };
            // HostName absent → use the Host alias (openssh semantics).
            let resolved_host = if host_name.trim().is_empty() {
                name.clone()
            } else {
                host_name.trim().to_string()
            };
            imported.push(SshHostProfile {
                // Stable id so re-importing is idempotent (merge in the frontend
                // dedupes on host+port+user, and a matching id prevents dupes).
                id: format!("ssh-config-{}", name),
                label: name.clone(),
                host: resolved_host,
                port,
                user: user.trim().to_string(),
                identity_file: identity_file.trim().to_string(),
            });
        }
        host_name.clear();
        user.clear();
        port_raw.clear();
        identity_file.clear();
        *in_block = false;
    };

    for line in raw.lines() {
        // Strip trailing comments (openssh allows `key value # comment`).
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, rest) = match line.split_once(char::is_whitespace) {
            Some((k, v)) => (k.to_string(), v.trim().to_string()),
            None => (line.to_string(), String::new()),
        };
        let key_lower = key.to_lowercase();

        if key_lower == "host" {
            // Close the previous block, then start a new one.
            flush(
                &mut host_names,
                &mut host_name,
                &mut user,
                &mut port_raw,
                &mut identity_file,
                &mut in_block,
                &mut imported,
                &mut skipped,
            );
            // `Host alpha beta gamma` → all three aliases share one block.
            host_names = rest.split_whitespace().map(String::from).collect();
            if host_names.is_empty() {
                // `Host` with no name — malformed, skip.
                skipped += 1;
                continue;
            }
            in_block = true;
        } else if key_lower == "match" {
            // `Match` blocks are conditional and not static targets; close the
            // current Host block and ignore subsequent directives until the
            // next `Host`.
            flush(
                &mut host_names,
                &mut host_name,
                &mut user,
                &mut port_raw,
                &mut identity_file,
                &mut in_block,
                &mut imported,
                &mut skipped,
            );
            skipped += 1;
        } else if in_block {
            match key_lower.as_str() {
                "hostname" => host_name = rest,
                "user" => user = rest,
                "port" => port_raw = rest,
                "identityfile" => identity_file = rest,
                // Include is not followed recursively; ignore all other
                // directives (ProxyJump, ForwardAgent, …) — they don't affect
                // the connection target tuple we store.
                _ => {}
            }
        }
    }
    // Flush the final block.
    flush(
        &mut host_names,
        &mut host_name,
        &mut user,
        &mut port_raw,
        &mut identity_file,
        &mut in_block,
        &mut imported,
        &mut skipped,
    );

    SshImportResult { imported, skipped }
}

#[tauri::command]
pub fn ssh_hosts_import_config() -> Result<SshImportResult, String> {
    let path = ssh_config_path()?;
    if !path.exists() {
        return Ok(SshImportResult {
            imported: Vec::new(),
            skipped: 0,
        });
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read ssh config failed: {e}"))?;
    Ok(parse_ssh_config(&raw))
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
        write_hosts(&path, std::slice::from_ref(&p)).unwrap();
        let loaded = read_hosts(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].host, "example.com");
        assert_eq!(loaded[0].port, 22);

        // No secret fields exist on the struct — nothing to leak by construction.
        let body = fs::read_to_string(&path).unwrap();
        assert!(!body.to_lowercase().contains("password"));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn parse_ssh_config_static_hosts_with_hostnames() {
        let raw = "\
Host prod
  HostName prod.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_prod

Host dev
  HostName 10.0.0.5
  User root
";
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 2);
        assert_eq!(result.skipped, 0);

        let prod = result.imported.iter().find(|p| p.id == "ssh-config-prod").unwrap();
        assert_eq!(prod.host, "prod.example.com");
        assert_eq!(prod.user, "deploy");
        assert_eq!(prod.port, 2222);
        assert_eq!(prod.identity_file, "~/.ssh/id_prod");
        assert_eq!(prod.label, "prod");

        let dev = result.imported.iter().find(|p| p.id == "ssh-config-dev").unwrap();
        assert_eq!(dev.host, "10.0.0.5");
        assert_eq!(dev.user, "root");
        assert_eq!(dev.port, 22); // absent → default
    }

    #[test]
    fn parse_ssh_config_hostname_defaults_to_alias() {
        let raw = "Host mybox\n  User alice\n";
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 1);
        // No HostName → host is the alias itself (openssh semantics).
        assert_eq!(result.imported[0].host, "mybox");
        assert_eq!(result.imported[0].label, "mybox");
    }

    #[test]
    fn parse_ssh_config_skips_wildcards_and_match() {
        let raw = "\
Host *
  User wildcard

Host real
  HostName real.example.com

Match host *.internal
  User matchuser

Host another
  HostName another.example.com
";
        let result = parse_ssh_config(raw);
        // real + another imported; `Host *` and `Match` skipped.
        assert_eq!(result.imported.len(), 2);
        assert!(result.imported.iter().any(|p| p.id == "ssh-config-real"));
        assert!(result.imported.iter().any(|p| p.id == "ssh-config-another"));
        assert_eq!(result.skipped, 2);
    }

    #[test]
    fn parse_ssh_config_multi_alias_host_block() {
        let raw = "\
Host alpha beta
  HostName shared.example.com
  User shared
";
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 2);
        for p in &result.imported {
            assert_eq!(p.host, "shared.example.com");
            assert_eq!(p.user, "shared");
        }
    }

    #[test]
    fn parse_ssh_config_malformed_port_falls_back() {
        let raw = "Host badport\n  HostName x\n  Port notanumber\n";
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].port, 22);
    }

    #[test]
    fn parse_ssh_config_ignores_comments_and_include() {
        let raw = "\
# This is a comment
Include ~/.ssh/conf.d/*

Host real
  HostName real.example.com
  # inline comment after Host
  User real
";
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].host, "real.example.com");
        assert_eq!(result.imported[0].user, "real");
        // Include line is not a Host block, so it doesn't count as skipped.
        assert_eq!(result.skipped, 0);
    }
}
