// Host-key verification (TOFU) against ~/.ssh/known_hosts.
//
// russh hands the server's public key to `Handler::check_server_key` and
// trusts whatever we return — returning `Ok(true)` unconditionally (as every
// example does) is a MITM hole. We implement trust-on-first-use:
//   - key matches a stored entry  -> accept
//   - host unknown                -> accept + remember (first use)
//   - host known, key differs     -> REJECT (possible MITM)
//
// We deliberately keep this small: plain `host` / `[host]:port` lines, no cert
// authorities, no revocation. Hashed (|1|) entries can't be matched by
// plaintext, but we DETECT their presence: when no plaintext entry matches and
// hashed entries exist, we return `Unverifiable` (not `Unknown`), so the caller
// won't silently trust + persist a possibly-rotated key — the MITM case TOFU
// exists to catch. Genuine first contact (no entries at all) still gets the
// permissive first-use accept.

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
    /// The store contains hashed (`|1|`) entries we can't match by plaintext,
    /// and no plaintext entry matched. We can neither confirm a match nor prove
    /// a mismatch, so we must NOT silently trust + persist a possibly-rotated
    /// key. Caller should accept only under an explicit allow-unknown policy and
    /// must NOT remember it (remembering would mask a real future mismatch).
    Unverifiable,
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

/// Match a single OpenSSH host pattern (supporting `*` and `?` wildcards)
/// against a host token. Plain patterns reduce to exact equality. Implemented
/// as a classic two-pointer glob matcher to avoid pulling in a regex crate.
fn host_pattern_match(pattern: &str, token: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = token.chars().collect();
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

/// Whether a comma-separated OpenSSH hosts field matches `token`, honoring
/// `*`/`?` wildcards and `!` negation. A negated pattern that matches excludes
/// the line entirely (OpenSSH: a negation wins as soon as it matches), even if
/// another positive pattern on the same line also matches.
fn hosts_field_matches(hosts_field: &str, token: &str) -> bool {
    let mut positive = false;
    for raw in hosts_field.split(',') {
        let pat = raw.trim();
        if pat.is_empty() {
            continue;
        }
        if let Some(neg) = pat.strip_prefix('!') {
            if host_pattern_match(neg, token) {
                return false; // explicit exclusion takes precedence
            }
        } else if host_pattern_match(pat, token) {
            positive = true;
        }
    }
    positive
}

/// Whether a pattern contains wildcard metacharacters (so a single entry can
/// legitimately cover many hosts with different keys).
fn is_wildcard_field(hosts_field: &str) -> bool {
    hosts_field.contains('*') || hosts_field.contains('?')
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

    // Exact (non-wildcard) entry for this host existed but no key matched.
    let mut exact_seen = false;
    // A wildcard entry (e.g. `*.example.com`) covered this host but its key
    // differs. Because one wildcard line legitimately spans many hosts with
    // different keys, that is NOT proof of a mismatch — but we also can't
    // confirm trust, so it must downgrade to Unverifiable, never auto-trust.
    let mut wildcard_seen = false;
    // Track whether the file has any hashed entries. If we don't find a
    // plaintext match, a hashed entry could be this host with a rotated key —
    // we can't tell, so we must not silently accept+remember (that would be the
    // exact MITM case TOFU exists to catch). OpenSSH hashes known_hosts by
    // default on many systems, so this is a realistic, not theoretical, case.
    let mut hashed_present = false;
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
        // Hashed entries (|1|salt|hash) can't be matched by plaintext here.
        // We can't decode them without an HMAC pass, but we MUST note they
        // exist so we don't mistake a hashed host for an unknown one.
        if hosts_field.starts_with('|') {
            hashed_present = true;
            continue;
        }
        // Honor comma-separated patterns, `*`/`?` wildcards, and `!` negation.
        if !hosts_field_matches(hosts_field, &token) {
            continue;
        }
        let is_wildcard = is_wildcard_field(hosts_field);
        // `rest` is "keytype base64 [comment]"; compare type+blob.
        let mut rit = rest.split_whitespace();
        if let (Some(kind), Some(blob)) = (rit.next(), rit.next()) {
            if format!("{kind} {blob}") == presented {
                return Verdict::Match;
            }
        }
        if is_wildcard {
            wildcard_seen = true;
        } else {
            exact_seen = true;
        }
    }

    if exact_seen {
        // A non-wildcard entry for this host existed but no key matched → MITM.
        Verdict::Mismatch
    } else if wildcard_seen || hashed_present {
        // A wildcard covered this host (key differs, but that's expected across
        // hosts) or hashed entries could be this host. Either way we can neither
        // confirm nor disprove — fail safe: accept only under allow-unknown and
        // never persist.
        Verdict::Unverifiable
    } else {
        // Genuinely first contact — standard TOFU.
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
        assert!(!auto_trusts(&Verdict::Match));
        assert!(auto_trusts(&Verdict::Unknown));
    }

    #[test]
    fn wildcard_patterns_match_like_openssh() {
        assert!(host_pattern_match("*.example.com", "host01.example.com"));
        assert!(host_pattern_match("host??.example.com", "host01.example.com"));
        assert!(host_pattern_match("*", "anything.at.all"));
        assert!(!host_pattern_match("*.example.com", "example.com"));
        assert!(!host_pattern_match("host?.example.com", "host01.example.com"));
        // Plain patterns are exact.
        assert!(host_pattern_match("example.com", "example.com"));
        assert!(!host_pattern_match("example.com", "evil.com"));
    }

    #[test]
    fn negation_excludes_even_when_a_wildcard_matches() {
        // `!secret.example.com,*.example.com` must reject the negated host.
        assert!(!hosts_field_matches(
            "!secret.example.com,*.example.com",
            "secret.example.com"
        ));
        // A non-negated host on the same line still matches.
        assert!(hosts_field_matches(
            "!secret.example.com,*.example.com",
            "host01.example.com"
        ));
        // Comma-separated exact tokens still work (regression).
        assert!(hosts_field_matches("a.com,b.com", "b.com"));
        assert!(!hosts_field_matches("a.com,b.com", "c.com"));
    }

    #[test]
    fn wildcard_field_detection() {
        assert!(is_wildcard_field("*.example.com"));
        assert!(is_wildcard_field("host?.example.com"));
        assert!(!is_wildcard_field("plain.example.com"));
        assert!(!is_wildcard_field("[host]:2222"));
    }
}
