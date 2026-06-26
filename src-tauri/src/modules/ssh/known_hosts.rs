// Host-key verification (TOFU) against ~/.ssh/known_hosts.
//
// russh hands the server's public key to `Handler::check_server_key` and
// trusts whatever we return — returning `Ok(true)` unconditionally (as every
// example does) is a MITM hole. We implement trust-on-first-use:
//   - key matches a stored entry  -> accept
//   - host unknown                -> accept + remember (first use)
//   - host known, key differs     -> REJECT (possible MITM)
//
// We deliberately keep this small: plain `host` / `[host]:port` lines, no
// hashed (|1|) entries, no cert authorities, no revocation. Hashed known_hosts
// are read-skip (we can't match them), so a hashed-only file degrades to
// first-use-accept rather than failing closed. That matches OpenSSH's
// permissive-but-warn posture for a GUI client and avoids locking users out.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use russh::keys::ssh_key::PublicKey;

/// Result of checking a presented host key against the store.
pub enum Verdict {
    /// Key matches a stored entry — safe to proceed.
    Match,
    /// Host not seen before — caller should accept and persist via `remember`.
    Unknown,
    /// Host known but the key differs — refuse the connection.
    Mismatch,
}

fn known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

/// Build the host token OpenSSH uses: `host` for port 22, `[host]:port` else.
fn host_token(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// OpenSSH stores keys as `host keytype base64`. We compare on the
/// `keytype base64` portion, which is exactly `PublicKey::to_openssh`
/// minus the trailing comment.
fn key_line(key: &PublicKey) -> Option<String> {
    let openssh = key.to_openssh().ok()?;
    // `to_openssh` => "ssh-ed25519 AAAA... [comment]" — keep type + blob only.
    let mut it = openssh.split_whitespace();
    let kind = it.next()?;
    let blob = it.next()?;
    Some(format!("{kind} {blob}"))
}

/// Check the presented key against `~/.ssh/known_hosts`.
pub fn verify(host: &str, port: u16, key: &PublicKey) -> Verdict {
    let Some(path) = known_hosts_path() else {
        return Verdict::Unknown;
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        // No known_hosts file yet — treat as first use.
        return Verdict::Unknown;
    };
    let Some(presented) = key_line(key) else {
        return Verdict::Unknown;
    };
    let token = host_token(host, port);

    let mut host_seen = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.splitn(2, char::is_whitespace);
        let Some(hosts_field) = parts.next() else {
            continue;
        };
        let Some(rest) = parts.next() else {
            continue;
        };
        // Skip hashed entries (|1|salt|hash) — we can't match them by plaintext.
        if hosts_field.starts_with('|') {
            continue;
        }
        // A hosts field may list several comma-separated patterns.
        let matches_host = hosts_field.split(',').any(|h| h == token);
        if !matches_host {
            continue;
        }
        host_seen = true;
        // `rest` is "keytype base64 [comment]"; compare type+blob.
        let mut rit = rest.split_whitespace();
        if let (Some(kind), Some(blob)) = (rit.next(), rit.next()) {
            if format!("{kind} {blob}") == presented {
                return Verdict::Match;
            }
        }
    }

    if host_seen {
        Verdict::Mismatch
    } else {
        Verdict::Unknown
    }
}

/// Append a newly-trusted host key to `~/.ssh/known_hosts` (first-use).
/// Best-effort: a write failure does not abort the connection, it just means
/// the host will prompt as "unknown" again next time.
pub fn remember(host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
    let Some(path) = known_hosts_path() else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let Some(line) = key_line(key) else {
        return Ok(());
    };
    let entry = format!("{} {}\n", host_token(host, port), line);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    f.write_all(entry.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_token_omits_default_port() {
        assert_eq!(host_token("example.com", 22), "example.com");
        assert_eq!(host_token("example.com", 2222), "[example.com]:2222");
    }
}
