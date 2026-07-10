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

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use russh::keys::ssh_key::PublicKey;
use sha1::Sha1;

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
        return Verdict::Unknown;
    };
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            let verdict = verdict_for_read_error(e.kind());
            // Only the present-but-unreadable case is noteworthy; a genuinely
            // absent file is the normal first-use path and stays quiet.
            if !matches!(verdict, Verdict::Unknown) {
                log::warn!(
                    "ssh: known_hosts at {} unreadable ({e}) — treating host as \
                     unverifiable rather than first-use",
                    path.display()
                );
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
    append_entry(&path, entry.as_bytes())
}

fn append_entry(path: &std::path::Path, entry: &[u8]) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(path)?;
    // Preserve the line-oriented format when another SSH client left the file
    // without a trailing newline. Appending directly would merge two host
    // records and make both unreadable.
    let len = f.metadata()?.len();
    if len > 0 {
        f.seek(SeekFrom::End(-1))?;
        let mut last = [0u8; 1];
        f.read_exact(&mut last)?;
        if last[0] != b'\n' {
            f.write_all(b"\n")?;
        }
    }
    f.write_all(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_token_omits_default_port() {
        assert_eq!(host_token("example.com", 22), "example.com");
        assert_eq!(host_token("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn appending_repairs_a_missing_trailing_newline() {
        let path = std::env::temp_dir().join(format!(
            "tunara-known-hosts-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::write(&path, b"old.example ssh-ed25519 AAAAOLD").expect("write fixture");
        append_entry(&path, b"new.example ssh-ed25519 AAAANEW\n").expect("append entry");
        assert_eq!(
            fs::read_to_string(&path).expect("read fixture"),
            "old.example ssh-ed25519 AAAAOLD\nnew.example ssh-ed25519 AAAANEW\n"
        );
        let _ = fs::remove_file(path);
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
