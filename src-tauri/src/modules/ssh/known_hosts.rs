// Host-key verification (TOFU) against ~/.ssh/known_hosts.
//
// russh hands the server's public key to `Handler::check_server_key` and
// trusts whatever we return — returning `Ok(true)` unconditionally (as every
// example does) is a MITM hole. We implement trust-on-first-use:
//   - key matches a stored entry  -> accept
//   - host unknown                -> accept + remember (first use)
//   - host known, key differs     -> REJECT (possible MITM)
//   - key marked @revoked         -> REJECT unconditionally
//
// We deliberately keep this small: plain `host` / `[host]:port` lines and
// OpenSSH markers. We reject @revoked keys. Certificate-authority validation is
// not implemented, so a matching @cert-authority line fails closed as
// Unverifiable rather than being mistaken for first use. OpenSSH's `|1|`
// hashed hostnames are verified with their HMAC-SHA1 scheme.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::local_safe_write::{self, Revision};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use russh::keys::ssh_key::PublicKey;
use sha1::Sha1;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum RememberError {
    TrustChanged,
    PreCommitFailure(std::io::Error),
    CommittedButDurabilityUnknown(std::io::Error),
}

impl std::fmt::Display for RememberError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TrustChanged => formatter.write_str("known_hosts trust changed while prompting"),
            Self::PreCommitFailure(error) => {
                write!(formatter, "known_hosts persistence failed: {error}")
            }
            Self::CommittedButDurabilityUnknown(error) => write!(
                formatter,
                "known_hosts committed but durability is unknown: {error}"
            ),
        }
    }
}

impl std::error::Error for RememberError {}

impl From<std::io::Error> for RememberError {
    fn from(error: std::io::Error) -> Self {
        Self::PreCommitFailure(error)
    }
}

/// Result of checking a presented host key against the store.
pub enum Verdict {
    /// Key matches a stored entry — safe to proceed.
    Match,
    /// Host not seen before — caller should accept and persist via `remember`.
    Unknown,
    /// Host known but the key differs — refuse the connection.
    Mismatch,
    /// The exact presented key is explicitly marked `@revoked` by OpenSSH.
    /// It must never be accepted, even under an allow-unknown policy.
    Revoked,
    /// The store contains a matching record we cannot safely evaluate (for
    /// example a certificate-authority marker), or a malformed hashed record.
    /// We can neither confirm a match nor prove a mismatch, so the caller must
    /// not silently trust and persist the presented key.
    Unverifiable,
}

fn known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

fn manager_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn process_lock(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let lock_path = path.with_file_name(".known_hosts.tunara.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(lock_path)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "cross-process known_hosts locking is unsupported",
        ))
    }
}

/// Build the host token OpenSSH uses: `host` for port 22, `[host]:port` else.
fn host_token(host: &str, port: u16) -> String {
    // OpenSSH canonicalizes DNS hostnames to lower case before matching and
    // hashing. ASCII normalization is also harmless for numeric IP literals.
    let host = host.to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

/// Match a single OpenSSH host pattern (supporting `*` and `?` wildcards)
/// against a host token. Plain patterns reduce to exact equality. Implemented
/// as a classic two-pointer glob matcher to avoid pulling in a regex crate.
fn host_pattern_match(pattern: &str, token: &str) -> bool {
    let p: Vec<char> = pattern.to_ascii_lowercase().chars().collect();
    let t: Vec<char> = token.to_ascii_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    // Backtrack points for the most recent `*`.
    let (mut star, mut mark): (Option<usize>, usize) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Result of matching a comma-separated OpenSSH hosts field against a token.
enum HostMatch {
    /// No positive pattern matched (or a negation excluded the line).
    None,
    /// Matched via an exact (non-wildcard) pattern.
    Exact,
    /// Matched via a wildcard pattern. The record still binds every matching
    /// host to its key, so a different presented key is a mismatch.
    Wildcard,
}

/// Match a comma-separated OpenSSH hosts field against `token`, honoring
/// `*`/`?` wildcards and `!` negation. A negated pattern that matches excludes
/// the line entirely (OpenSSH: a negation wins as soon as it matches). When a
/// positive match occurs, reports whether the *specific matching pattern* was a
/// wildcard — so an exact entry sharing a line with an unrelated wildcard isn't
/// coarsely treated as wildcard.
fn match_hosts_field(hosts_field: &str, token: &str) -> HostMatch {
    let mut result = HostMatch::None;
    for raw in hosts_field.split(',') {
        let pat = raw.trim();
        if pat.is_empty() {
            continue;
        }
        if let Some(neg) = pat.strip_prefix('!') {
            if host_pattern_match(neg, token) {
                return HostMatch::None; // explicit exclusion takes precedence
            }
        } else if host_pattern_match(pat, token) {
            // An exact match is the strongest signal; don't let a later wildcard
            // on the same line weaken it.
            if pat.contains('*') || pat.contains('?') {
                if matches!(result, HostMatch::None) {
                    result = HostMatch::Wildcard;
                }
            } else {
                result = HostMatch::Exact;
            }
        }
    }
    result
}

/// Match OpenSSH's hashed-host form: `|1|base64(salt)|base64(HMAC-SHA1)`.
/// `None` means the record itself is malformed; a valid non-match is
/// `Some(false)` and must not make unrelated hosts unverifiable.
fn match_hashed_host(hosts_field: &str, token: &str) -> Option<bool> {
    let encoded = hosts_field.strip_prefix("|1|")?;
    let mut fields = encoded.split('|');
    let salt = B64.decode(fields.next()?).ok()?;
    let expected = B64.decode(fields.next()?).ok()?;
    if fields.next().is_some() || expected.len() != 20 {
        return None;
    }
    let mut mac = Hmac::<Sha1>::new_from_slice(&salt).ok()?;
    let token = token.to_ascii_lowercase();
    mac.update(token.as_bytes());
    Some(mac.verify_slice(&expected).is_ok())
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

/// Classify a `known_hosts` read failure. Only a genuinely-absent file is
/// legitimate first use (TOFU `Unknown`, which the caller may auto-trust +
/// persist). Any OTHER error means the file is present but we couldn't read it
/// this time (EACCES on a hardened `~/.ssh`, the path being a directory, a
/// transient FS/IO error, or an active attacker making it unreadable): it may
/// hold this host's real key or a mismatch we must honor, so we fail closed as
/// `Unverifiable` — never the auto-trusting `Unknown`. Pure, so this
/// security-relevant branch is unit-testable without touching the real store.
fn verdict_for_read_error(kind: std::io::ErrorKind) -> Verdict {
    if kind == std::io::ErrorKind::NotFound {
        Verdict::Unknown
    } else {
        Verdict::Unverifiable
    }
}

/// Check already-read known_hosts contents. Keeping parsing separate from file
/// IO makes marker handling testable without touching the user's real SSH
/// configuration.
fn verify_contents(contents: &str, token: &str, presented: &str) -> Verdict {
    let Some((presented_kind, presented_blob)) = presented.split_once(' ') else {
        return Verdict::Unverifiable;
    };
    // Do not return early for a trust record: a later @revoked line for the
    // same key must override it, independent of file ordering.
    let mut trusted_match = false;
    // A plain or hashed record matched this host, but its key did not.
    let mut host_record_seen = false;
    // A malformed hashed record could have represented this host, so it keeps
    // first-use from silently winning. Valid hashed records are matched exactly
    // and do not contaminate unrelated hosts.
    let mut malformed_hashed_seen = false;
    // CA and unknown markers are security-relevant records, but this compact
    // verifier cannot validate them. Never reinterpret them as first contact.
    let mut unverifiable_marker_seen = false;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let mut fields = line.split_whitespace();
        let Some(first) = fields.next() else {
            continue;
        };
        let (marker, hosts_field) = if first.starts_with('@') {
            let Some(hosts) = fields.next() else {
                continue;
            };
            (Some(first), hosts)
        } else {
            (None, first)
        };
        let (Some(kind), Some(blob)) = (fields.next(), fields.next()) else {
            continue;
        };

        let matched = if hosts_field.starts_with('|') {
            match match_hashed_host(hosts_field, token) {
                Some(true) => HostMatch::Exact,
                Some(false) => HostMatch::None,
                None => {
                    malformed_hashed_seen = true;
                    HostMatch::None
                }
            }
        } else {
            match_hosts_field(hosts_field, token)
        };
        if matches!(matched, HostMatch::None) {
            continue;
        }

        let key_matches = kind == presented_kind && blob == presented_blob;

        match marker {
            Some("@revoked") => {
                if key_matches {
                    return Verdict::Revoked;
                }
                // A revocation record applies only to its key. It neither
                // trusts nor rejects a different presented key.
                continue;
            }
            Some("@cert-authority") | Some(_) => {
                unverifiable_marker_seen = true;
                continue;
            }
            None => {}
        }

        if key_matches {
            trusted_match = true;
            continue;
        }
        match matched {
            HostMatch::Exact | HostMatch::Wildcard => host_record_seen = true,
            HostMatch::None => {}
        }
    }

    if trusted_match {
        Verdict::Match
    } else if host_record_seen {
        Verdict::Mismatch
    } else if malformed_hashed_seen || unverifiable_marker_seen {
        Verdict::Unverifiable
    } else {
        Verdict::Unknown
    }
}

/// Check the presented key against `~/.ssh/known_hosts`.
pub fn verify(host: &str, port: u16, key: &PublicKey) -> Verdict {
    let Some(path) = known_hosts_path() else {
        return Verdict::Unverifiable;
    };
    let contents = match local_safe_write::read(&path) {
        Ok(Some(bytes)) => match String::from_utf8(bytes) {
            Ok(contents) => contents,
            Err(_) => return Verdict::Unverifiable,
        },
        Ok(None) => return Verdict::Unknown,
        Err(error) => {
            let kind = match &error {
                local_safe_write::Error::Io(error) => error.kind(),
                _ => std::io::ErrorKind::PermissionDenied,
            };
            let verdict = verdict_for_read_error(kind);
            // Only the present-but-unreadable case is noteworthy; a genuinely
            // absent file is the normal first-use path and stays quiet.
            if !matches!(verdict, Verdict::Unknown) {
                log::warn!("ssh known_hosts unreadable — treating host as unverifiable");
            }
            return verdict;
        }
    };
    let Some(presented) = key_line(key) else {
        return Verdict::Unknown;
    };
    let token = host_token(host, port);
    verify_contents(&contents, &token, &presented)
}

/// Append a newly-trusted host key to `~/.ssh/known_hosts` (first-use).
/// Best-effort: a write failure does not abort the connection, it just means
/// the host will prompt as "unknown" again next time.
pub fn remember(host: &str, port: u16, key: &PublicKey) -> Result<(), RememberError> {
    let Some(path) = known_hosts_path() else {
        return Err(std::io::Error::other("known_hosts path unavailable").into());
    };
    let _guard = manager_lock()
        .lock()
        .map_err(|_| std::io::Error::other("known_hosts lock poisoned"))?;
    local_safe_write::ensure_parent(&path)
        .map_err(|error| RememberError::PreCommitFailure(std::io::Error::other(error)))?;
    // Serialize with other Tunara processes. flock is attached to this open
    // descriptor (no stale lock-file ownership heuristic or unsafe deletion).
    let _process_lock = process_lock(&path).map_err(RememberError::PreCommitFailure)?;
    let Some(line) = key_line(key) else {
        return Err(RememberError::TrustChanged);
    };
    let entry = format!("{} {}\n", host_token(host, port), line);
    let old: Vec<u8> = local_safe_write::read(&path)
        .map_err(|error| RememberError::PreCommitFailure(std::io::Error::other(error)))?
        .unwrap_or_default();
    let current = std::str::from_utf8(&old).map_err(|_| RememberError::TrustChanged)?;
    match verify_contents(current, &host_token(host, port), &line) {
        Verdict::Match => return Ok(()),
        Verdict::Unknown => {}
        Verdict::Mismatch | Verdict::Revoked | Verdict::Unverifiable => {
            return Err(RememberError::TrustChanged);
        }
    }
    // Re-read under the process lock and avoid duplicate exact records.
    if old
        .split(|b| *b == b'\n')
        .any(|line| line == entry.trim_ascii_end().as_bytes())
    {
        return Ok(());
    }
    let mut next = old.clone();
    if !next.is_empty() && !next.ends_with(b"\n") {
        next.push(b'\n');
    }
    next.extend_from_slice(entry.as_bytes());
    let expected = match local_safe_write::read(&path)
        .map_err(|error| RememberError::PreCommitFailure(std::io::Error::other(error)))?
    {
        Some(current) if current == old => local_safe_write::revision(&old),
        Some(_) => return Err(RememberError::TrustChanged),
        None if old.is_empty() => Revision::Missing,
        None => return Err(RememberError::TrustChanged),
    };
    local_safe_write::replace(&path, &next, &expected).map_err(|error| match error {
        local_safe_write::Error::Conflict => RememberError::TrustChanged,
        local_safe_write::Error::DurabilityUnknown(error) => {
            RememberError::CommittedButDurabilityUnknown(error)
        }
        error => RememberError::PreCommitFailure(std::io::Error::other(error)),
    })
}

/// Re-evaluate the current trust store immediately before a caller accepts an
/// unknown key for this process only. A newly added mismatch/revocation/CA or
/// an unreadable store always cancels the connection.
pub fn confirm_session_only(host: &str, port: u16, key: &PublicKey) -> bool {
    let Some(path) = known_hosts_path() else {
        return false;
    };
    let Ok(_guard) = manager_lock().lock() else {
        return false;
    };
    let Ok(bytes) = local_safe_write::read(&path) else {
        return false;
    };
    let Some(line) = key_line(key) else {
        return false;
    };
    let verdict = match bytes {
        None => Verdict::Unknown,
        Some(bytes) => match std::str::from_utf8(&bytes) {
            Ok(contents) => verify_contents(contents, &host_token(host, port), &line),
            Err(_) => Verdict::Unverifiable,
        },
    };
    matches!(verdict, Verdict::Unknown | Verdict::Match)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntryV1 {
    pub entry_id: String,
    pub line: usize,
    pub marker: Option<String>,
    pub pattern_display: String,
    pub key_type: String,
    pub fingerprint: String,
    pub manageable: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsSnapshotV1 {
    pub revision: String,
    pub entries: Vec<KnownHostEntryV1>,
}

fn snapshot(bytes: &[u8]) -> KnownHostsSnapshotV1 {
    let revision = format!("{:x}", Sha256::digest(bytes));
    let mut entries = Vec::new();
    for (index, raw) in bytes.split(|b| *b == b'\n').enumerate() {
        let text = String::from_utf8_lossy(raw)
            .trim_end_matches('\r')
            .to_string();
        let mut fields = text.split_whitespace();
        let Some(first) = fields.next() else { continue };
        if first.starts_with('#') {
            continue;
        }
        let (marker, pattern) = if first.starts_with('@') {
            (Some(first.to_string()), fields.next().unwrap_or_default())
        } else {
            (None, first)
        };
        let Some(key_type) = fields.next() else {
            continue;
        };
        let Some(blob) = fields.next() else { continue };
        let fingerprint = B64
            .decode(blob)
            .ok()
            .map(|key| {
                format!(
                    "SHA256:{}",
                    B64.encode(Sha256::digest(key)).trim_end_matches('=')
                )
            })
            .unwrap_or_else(|| "invalid".into());
        let mut identity = raw.to_vec();
        identity.extend_from_slice(&((index + 1) as u64).to_le_bytes());
        let entry_id = format!("{:x}", Sha256::digest(identity));
        entries.push(KnownHostEntryV1 {
            entry_id,
            line: index + 1,
            marker: marker.clone(),
            pattern_display: pattern.to_string(),
            key_type: key_type.to_string(),
            fingerprint,
            manageable: marker.as_deref() != Some("@cert-authority"),
        });
    }
    KnownHostsSnapshotV1 { revision, entries }
}

fn fresh_bytes(path: &std::path::Path) -> Result<Vec<u8>, String> {
    match local_safe_write::read(path) {
        Ok(Some(bytes)) => Ok(bytes),
        Ok(None) => Ok(Vec::new()),
        Err(local_safe_write::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(Vec::new())
        }
        Err(error) => Err(format!("SSH_KNOWN_HOSTS_READ: {error}")),
    }
}

fn remove_entry_bytes(
    old: &[u8],
    expected_revision: &str,
    entry_id: &str,
) -> Result<Vec<u8>, &'static str> {
    let old_snapshot = snapshot(old);
    if old_snapshot.revision != expected_revision {
        return Err("SSH_KNOWN_HOSTS_CONFLICT");
    }
    let entry = old_snapshot
        .entries
        .iter()
        .find(|entry| entry.entry_id == entry_id)
        .ok_or("SSH_KNOWN_HOSTS_ENTRY_NOT_FOUND")?;
    if !entry.manageable {
        return Err("SSH_KNOWN_HOSTS_UNMANAGEABLE");
    }
    let mut next = Vec::new();
    for (index, segment) in old.split_inclusive(|byte| *byte == b'\n').enumerate() {
        if index + 1 != entry.line {
            next.extend_from_slice(segment);
        }
    }
    Ok(next)
}

#[tauri::command]
pub fn ssh_known_hosts_list_v1() -> Result<KnownHostsSnapshotV1, String> {
    (|| {
        let _guard = manager_lock()
            .lock()
            .map_err(|_| "SSH_KNOWN_HOSTS_LOCK".to_string())?;
        let path = known_hosts_path().ok_or("SSH_KNOWN_HOSTS_UNSUPPORTED")?;
        Ok(snapshot(&fresh_bytes(&path)?))
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::KnownHosts, error)
    })
}
#[tauri::command]
pub fn ssh_known_hosts_refresh_v1() -> Result<KnownHostsSnapshotV1, String> {
    (|| {
        let _guard = manager_lock()
            .lock()
            .map_err(|_| "SSH_KNOWN_HOSTS_LOCK".to_string())?;
        let path = known_hosts_path().ok_or("SSH_KNOWN_HOSTS_UNSUPPORTED")?;
        Ok(snapshot(&fresh_bytes(&path)?))
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::KnownHosts, error)
    })
}
#[tauri::command]
pub fn ssh_known_hosts_remove_v1(
    expected_revision: String,
    entry_id: String,
) -> Result<KnownHostsSnapshotV1, String> {
    (|| {
        let _guard = manager_lock()
            .lock()
            .map_err(|_| "SSH_KNOWN_HOSTS_LOCK".to_string())?;
        let path = known_hosts_path().ok_or("SSH_KNOWN_HOSTS_UNSUPPORTED")?;
        local_safe_write::ensure_parent(&path)
            .map_err(|_| "SSH_KNOWN_HOSTS_UNSUPPORTED".to_string())?;
        let _process_lock =
            process_lock(&path).map_err(|_| "SSH_KNOWN_HOSTS_UNSUPPORTED".to_string())?;
        let old = fresh_bytes(&path)?;
        let next = remove_entry_bytes(&old, &expected_revision, &entry_id)?;
        let expected = if old.is_empty() {
            match local_safe_write::read(&path) {
                Ok(Some(_)) => local_safe_write::revision(&old),
                Ok(None) => Revision::Missing,
                Err(error) => return Err(format!("SSH_KNOWN_HOSTS_READ: {error}")),
            }
        } else {
            local_safe_write::revision(&old)
        };
        local_safe_write::replace(&path, &next, &expected).map_err(|e| {
            if matches!(e, local_safe_write::Error::Conflict) {
                "SSH_KNOWN_HOSTS_CONFLICT".into()
            } else {
                format!("SSH_KNOWN_HOSTS_WRITE: {e}")
            }
        })?;
        Ok(snapshot(&next))
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::KnownHosts, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_token_omits_default_port() {
        assert_eq!(host_token("example.com", 22), "example.com");
        assert_eq!(host_token("example.com", 2222), "[example.com]:2222");
    }

    // Guard the security-relevant invariant: Unverifiable must stay a distinct
    // verdict, never collapsed into Unknown (which would auto-trust+persist a
    // possibly-rotated key on a hashed-known_hosts host).
    #[test]
    fn unverifiable_is_not_unknown() {
        fn auto_trusts(v: &Verdict) -> bool {
            matches!(v, Verdict::Unknown)
        }
        assert!(!auto_trusts(&Verdict::Unverifiable));
        assert!(!auto_trusts(&Verdict::Mismatch));
        assert!(!auto_trusts(&Verdict::Revoked));
        assert!(!auto_trusts(&Verdict::Match));
        assert!(auto_trusts(&Verdict::Unknown));
    }

    // Regression: a present-but-unreadable known_hosts must NOT degrade to the
    // auto-trusting Unknown verdict. Only a truly-absent file is first-use;
    // EACCES / is-a-directory / transient IO must fail closed as Unverifiable,
    // so an AcceptUnknown policy can't silently trust+persist an unvetted key
    // while the store is unreadable. This FAILS on the old code that mapped
    // every read error to Unknown.
    #[test]
    fn unreadable_store_fails_closed_not_first_use() {
        use std::io::ErrorKind;
        // Absent file → legitimate first use.
        assert!(matches!(
            verdict_for_read_error(ErrorKind::NotFound),
            Verdict::Unknown
        ));
        // Present-but-unreadable variants → fail closed, never auto-trust.
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::Other, // e.g. EISDIR (path is a directory) / transient IO
        ] {
            assert!(
                matches!(verdict_for_read_error(kind), Verdict::Unverifiable),
                "read error {kind:?} must fail closed as Unverifiable"
            );
        }
    }

    #[test]
    fn wildcard_patterns_match_like_openssh() {
        assert!(host_pattern_match("*.example.com", "host01.example.com"));
        assert!(host_pattern_match(
            "host??.example.com",
            "host01.example.com"
        ));
        assert!(host_pattern_match("*", "anything.at.all"));
        assert!(!host_pattern_match("*.example.com", "example.com"));
        assert!(!host_pattern_match(
            "host?.example.com",
            "host01.example.com"
        ));
        // Plain patterns are exact.
        assert!(host_pattern_match("example.com", "example.com"));
        assert!(!host_pattern_match("example.com", "evil.com"));
    }

    #[test]
    fn negation_excludes_even_when_a_wildcard_matches() {
        // `!secret.example.com,*.example.com` must reject the negated host.
        assert!(matches!(
            match_hosts_field("!secret.example.com,*.example.com", "secret.example.com"),
            HostMatch::None
        ));
        // A non-negated host on the same line still matches (via wildcard).
        assert!(matches!(
            match_hosts_field("!secret.example.com,*.example.com", "host01.example.com"),
            HostMatch::Wildcard
        ));
        // Comma-separated exact tokens still work (regression).
        assert!(matches!(
            match_hosts_field("a.com,b.com", "b.com"),
            HostMatch::Exact
        ));
        assert!(matches!(
            match_hosts_field("a.com,b.com", "c.com"),
            HostMatch::None
        ));
    }

    #[test]
    fn exact_match_not_weakened_by_unrelated_wildcard_on_same_line() {
        // `host.com,*.other` matching `host.com` must report Exact, so a rotated
        // key for host.com surfaces as Mismatch — not downgraded to Unverifiable.
        assert!(matches!(
            match_hosts_field("host.com,*.other", "host.com"),
            HostMatch::Exact
        ));
        // A pure wildcard line still reports Wildcard.
        assert!(matches!(
            match_hosts_field("*.example.com", "host01.example.com"),
            HostMatch::Wildcard
        ));
    }

    #[test]
    fn wildcard_record_rejects_a_different_key() {
        let contents = "*.example.com ssh-ed25519 AAAAEXPECTED\n";
        assert!(matches!(
            verify_contents(contents, "host.example.com", "ssh-ed25519 AAAACHANGED"),
            Verdict::Mismatch
        ));
    }

    #[test]
    fn openssh_hashed_hosts_match_only_their_own_token() {
        // Fixture from russh's own known_hosts test: HMAC-SHA1 of example.com.
        let hashed = "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak=";
        assert_eq!(match_hashed_host(hashed, "example.com"), Some(true));
        assert_eq!(match_hashed_host(hashed, "EXAMPLE.COM"), Some(true));
        assert_eq!(match_hashed_host(hashed, "unrelated.example"), Some(false));
        assert_eq!(match_hashed_host("|1|broken|record", "example.com"), None);
    }

    #[test]
    fn dns_host_matching_is_ascii_case_insensitive_like_openssh() {
        assert_eq!(host_token("EXAMPLE.COM", 22), "example.com");
        assert!(host_pattern_match("*.Example.COM", "API.EXAMPLE.com"));
        let contents = "example.com ssh-ed25519 AAAAEXPECTED\n";
        assert!(matches!(
            verify_contents(
                contents,
                &host_token("EXAMPLE.COM", 22),
                "ssh-ed25519 AAAACHANGED"
            ),
            Verdict::Mismatch
        ));
    }

    #[test]
    fn unrelated_hashed_entry_does_not_poison_first_use() {
        let contents = "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 AAAAEXAMPLE\n";
        assert!(matches!(
            verify_contents(contents, "new.example", "ssh-ed25519 AAAANEW"),
            Verdict::Unknown
        ));
        assert!(matches!(
            verify_contents(contents, "example.com", "ssh-ed25519 AAAAEXAMPLE"),
            Verdict::Match
        ));
        assert!(matches!(
            verify_contents(contents, "example.com", "ssh-ed25519 AAAACHANGED"),
            Verdict::Mismatch
        ));
    }

    #[test]
    fn revoked_marker_rejects_the_exact_presented_key() {
        let contents = concat!(
            "example.com ssh-ed25519 AAAAREVOKED previously-trusted\n",
            "@revoked * ssh-ed25519 AAAAREVOKED compromised\n",
        );
        assert!(matches!(
            verify_contents(contents, "example.com", "ssh-ed25519 AAAAREVOKED"),
            Verdict::Revoked
        ));
    }

    #[test]
    fn revoked_marker_does_not_revoke_a_different_key() {
        let contents = "@revoked example.com ssh-ed25519 AAAAOLD compromised\n";
        assert!(matches!(
            verify_contents(contents, "example.com", "ssh-ed25519 AAAANEW"),
            Verdict::Unknown
        ));
    }

    #[test]
    fn certificate_authority_marker_never_becomes_first_use() {
        let contents = "@cert-authority *.example.com ssh-ed25519 AAAACA office-ca\n";
        assert!(matches!(
            verify_contents(contents, "host.example.com", "ssh-ed25519 AAAASERVER"),
            Verdict::Unverifiable
        ));
    }

    #[test]
    fn manager_snapshot_is_stable_and_does_not_reverse_hashed_hosts() {
        let bytes = concat!(
            "# keep this comment\n",
            "|1|salt|hash ssh-ed25519 AAAA comment\n",
            "@cert-authority *.example.com ssh-ed25519 AAAA ca\n",
            "plain.example ssh-rsa AQID no-newline",
        )
        .as_bytes();
        let first = snapshot(bytes);
        let second = snapshot(bytes);
        assert_eq!(first.revision, second.revision);
        assert_eq!(first.entries.len(), 3);
        assert_eq!(first.entries[0].entry_id, second.entries[0].entry_id);
        assert_eq!(first.entries[0].pattern_display, "|1|salt|hash");
        assert!(!first.entries[1].manageable);
        assert_eq!(first.entries[2].line, 4);
    }

    #[test]
    fn manager_remove_uses_revision_cas_and_preserves_other_bytes() {
        let old = b"# comment\r\nfirst ssh-ed25519 AAAA one\nsecond ssh-rsa AQID two";
        let old_snapshot = snapshot(old);
        let first_id = old_snapshot.entries[0].entry_id.clone();
        assert_eq!(
            remove_entry_bytes(old, "stale-revision", &first_id),
            Err("SSH_KNOWN_HOSTS_CONFLICT")
        );
        let next = remove_entry_bytes(old, &old_snapshot.revision, &first_id).unwrap();
        assert_eq!(next, b"# comment\r\nsecond ssh-rsa AQID two");
    }

    #[test]
    fn ordinary_matching_key_still_wins_when_a_ca_marker_is_present() {
        let contents = concat!(
            "@cert-authority *.example.com ssh-ed25519 AAAACA office-ca\n",
            "host.example.com ssh-ed25519 AAAASERVER\n",
        );
        assert!(matches!(
            verify_contents(contents, "host.example.com", "ssh-ed25519 AAAASERVER"),
            Verdict::Match
        ));
    }
}
