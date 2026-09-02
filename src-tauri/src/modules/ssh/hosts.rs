// Saved SSH host profiles (Phase 2).
//
// Profiles live in their own file, ~/.config/tunara/hosts.toml, separate from
// the comment-preserving appearance config — host management is a flat
// load/save/remove list and doesn't need toml_edit's merge machinery.
//
// IMPORTANT: profiles store NO secrets. Only host/port/user and an optional
// identity-file PATH. Passwords and passphrases are never written to disk.

use std::cell::Cell;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::auth::AuthMethod;
use super::local_safe_write::{self, Revision};

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
    /// The legacy direct `ssh_open` adapter intentionally ignores this until
    /// the stream-based connector lands in B2.
    pub proxy_jump_profile_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct HostsFile {
    /// Missing means the legacy v1/direct schema. Reads never rewrite it.
    schema_version: Option<u8>,
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

fn read_hosts_with_revision(path: &Path) -> Result<(Vec<SshHostProfile>, Revision), String> {
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

fn read_hosts(path: &Path) -> Result<Vec<SshHostProfile>, String> {
    read_hosts_with_revision(path).map(|(hosts, _)| hosts)
}

fn write_hosts(path: &Path, hosts: &[SshHostProfile], expected: &Revision) -> Result<(), String> {
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

fn validate_profile_auth_paths(profile: &mut SshHostProfile) -> Result<(), String> {
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
        return Err("CertificateFile requires key or automatic authentication and IdentityFile".into());
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

/// Result of importing host profiles from `~/.ssh/config`.
/// `imported` are the parsed static `Host` blocks; `skipped` counts wildcard
/// `Host *` / `Match` / malformed blocks that were intentionally ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SshImportDiagnostic {
    pub source: String,
    pub line: usize,
    pub alias: String,
    pub code: String,
    pub directive: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SshImportResult {
    pub imported: Vec<SshHostProfile>,
    pub skipped: usize,
    pub diagnostics: Vec<SshImportDiagnostic>,
}

/// Resolve `~/.ssh/config`. Uses `dirs::home_dir()` (not `$HOME`) so it matches
/// the same home `hosts_path()`/auth resolve under a macOS GUI launch where
/// `$HOME` may be unset.
fn ssh_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    Ok(home.join(".ssh").join("config"))
}

/// Tokenize one OpenSSH config line without treating quoted spaces or an
/// escaped `#` as separators/comments. Returns `None` for an unfinished quote
/// or escape so malformed input is skipped instead of partially imported.
fn ssh_config_tokens(line: &str) -> Option<Vec<String>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = line.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if chars
                .peek()
                .is_some_and(|next| next.is_whitespace() || matches!(next, '\\' | '\'' | '"' | '#'))
            {
                token.push(chars.next().expect("peeked escaped character"));
            } else {
                // OpenSSH preserves backslashes it does not recognize rather
                // than silently changing the endpoint or path.
                token.push('\\');
            }
            started = true;
            continue;
        }
        if let Some(expected) = quote {
            if ch == expected {
                quote = None;
            } else {
                token.push(ch);
            }
            started = true;
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                started = true;
            }
            '#' if !started => break,
            '#' => token.push('#'),
            c if c.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut token));
                    started = false;
                }
            }
            _ => {
                token.push(ch);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        tokens.push(token);
    }
    Some(tokens)
}

const INCLUDE_MAX_DEPTH: usize = 8;
const INCLUDE_MAX_FILES: usize = 64;
const INCLUDE_MAX_BYTES: usize = 1024 * 1024;
const INCLUDE_MAX_DIR_ENTRIES: usize = 4096;
const INCLUDE_MAX_EXPANDED_PATHS: usize = 1024;
const CONFIG_MAX_BLOCKS: usize = 4096;
const CONFIG_MAX_ALIASES: usize = 2048;
const CONFIG_MAX_SELECTOR_EVALUATIONS: usize = 20_000;
const PATTERN_MAX_OPERATIONS: usize = 4_096;
const CANONICAL_MAX_LOOKUPS: usize = 64;

struct PatternBudget {
    operations: Cell<usize>,
}

impl PatternBudget {
    fn new() -> Self {
        Self {
            operations: Cell::new(0),
        }
    }

    fn charge(&self) -> Result<(), String> {
        let operations = self.operations.get().saturating_add(1);
        self.operations.set(operations);
        if operations > PATTERN_MAX_OPERATIONS {
            Err("pattern_operation_limit".into())
        } else {
            Ok(())
        }
    }
}

fn is_resource_limit(code: &str) -> bool {
    code.ends_with("_limit")
}

#[derive(Clone, Debug)]
struct LocatedDirective {
    source: String,
    line: usize,
    key: String,
    values: Vec<String>,
}

#[derive(Clone, Debug)]
enum Selector {
    Global,
    Host(Vec<String>),
    Match(LocatedDirective),
}

#[derive(Clone, Debug)]
struct ConfigBlock {
    /// Selectors inherited at an Include call site.  The block selector is
    /// local to its file; this guard is what prevents included Host sections
    /// from escaping an inactive parent section.
    guards: Vec<Selector>,
    selector: Selector,
    directives: Vec<LocatedDirective>,
    hazards: Vec<(LocatedDirective, String)>,
}

#[derive(Clone, Debug)]
struct ResolverLimits {
    depth: usize,
    files: usize,
    bytes: usize,
    dir_entries: usize,
    expanded_paths: usize,
}

impl Default for ResolverLimits {
    fn default() -> Self {
        Self {
            depth: INCLUDE_MAX_DEPTH,
            files: INCLUDE_MAX_FILES,
            bytes: INCLUDE_MAX_BYTES,
            dir_entries: INCLUDE_MAX_DIR_ENTRIES,
            expanded_paths: INCLUDE_MAX_EXPANDED_PATHS,
        }
    }
}

#[derive(Default)]
struct EffectiveConfig {
    host_name: Option<(String, LocatedDirective)>,
    user: Option<(String, LocatedDirective)>,
    port: Option<(String, LocatedDirective)>,
    proxy_jump: Option<(String, LocatedDirective)>,
    identities: Vec<(String, LocatedDirective)>,
    certificates: Vec<(String, LocatedDirective)>,
    canonicalize_hostname: Option<(String, LocatedDirective)>,
    canonical_domains: Option<(Vec<String>, LocatedDirective)>,
    canonicalize_max_dots: Option<(String, LocatedDirective)>,
    canonicalize_fallback_local: Option<(String, LocatedDirective)>,
    canonicalize_permitted_cnames: Option<(Vec<String>, LocatedDirective)>,
    additive_applied: std::collections::BTreeSet<(String, usize, String)>,
    rejection: Option<(LocatedDirective, String)>,
}

#[derive(Clone, Copy)]
struct MatchPhase {
    canonical: bool,
    final_pass: bool,
}

const INITIAL_MATCH_PHASE: MatchPhase = MatchPhase {
    canonical: false,
    final_pass: false,
};

struct CanonicalLookup {
    canonical_name: Option<String>,
}

struct ConfigResolver<'a> {
    home: &'a Path,
    boundary: PathBuf,
    limits: ResolverLimits,
    files: usize,
    bytes: usize,
    dir_entries: usize,
    expanded_paths: usize,
    stack: Vec<PathBuf>,
    blocks: Vec<ConfigBlock>,
    exhausted: bool,
    // Only failures which cannot be associated with a parsed textual location.
    hazards: Vec<(LocatedDirective, String)>,
}

fn diagnostic(
    source: &str,
    line: usize,
    alias: &str,
    code: &str,
    directive: &str,
) -> SshImportDiagnostic {
    SshImportDiagnostic {
        source: source.to_string(),
        line,
        alias: alias.to_string(),
        code: code.to_string(),
        directive: directive.to_string(),
    }
}

fn profile_id(alias: &str) -> String {
    format!("ssh-config-{alias}")
}

fn synthetic_jump_id(value: &str) -> String {
    // Stable FNV-1a rather than DefaultHasher, whose output is not a persisted
    // compatibility contract across Rust versions.
    let hash = value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        });
    format!("ssh-config-jump-{hash:016x}")
}

fn valid_resolved_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'))
}

fn valid_resolved_user(value: &str) -> bool {
    value.len() <= 256
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '@' | '\\'))
}

fn literal_jump_profile(value: &str) -> Option<SshHostProfile> {
    if value.contains(['%', '$', '~', ',', '*', '?']) {
        return None;
    }
    let (user, endpoint) = value.rsplit_once('@')?;
    let (host, port_raw) = if let Some(bracketed) = endpoint.strip_prefix('[') {
        let (host, port_raw) = bracketed.split_once("]:")?;
        if host.is_empty() || host.contains(']') {
            return None;
        }
        (host, port_raw)
    } else {
        let (host, port_raw) = endpoint.split_once(':')?;
        if host.contains(':') || port_raw.contains(':') {
            return None;
        }
        (host, port_raw)
    };
    let port = port_raw.parse::<u16>().ok().filter(|port| *port > 0)?;
    if !valid_resolved_user(user) || user.is_empty() || !valid_resolved_host(host) {
        return None;
    }
    Some(SshHostProfile {
        id: synthetic_jump_id(value),
        label: value.to_string(),
        host: host.to_string(),
        port,
        user: user.to_string(),
        auth_method: None,
        identity_file: String::new(),
        certificate_file: String::new(),
        proxy_jump_profile_id: String::new(),
    })
}

fn glob_match(pattern: &str, value: &str) -> Result<bool, String> {
    fn class_match(
        pattern: &[u8],
        start: usize,
        value: u8,
        operations: &mut usize,
    ) -> Option<(bool, usize)> {
        let mut end = start;
        while pattern.get(end) != Some(&b']') {
            *operations += 1;
            if *operations > PATTERN_MAX_OPERATIONS || end >= pattern.len() {
                return None;
            }
            end += 1;
        }
        let mut index = start;
        let negated = matches!(pattern.get(index), Some(b'!' | b'^'));
        if negated {
            index += 1;
        }
        let mut matched = false;
        while index < end {
            *operations += 1;
            if *operations > PATTERN_MAX_OPERATIONS {
                return None;
            }
            let first = pattern[index];
            if index + 2 < end && pattern[index + 1] == b'-' {
                matched |= (first..=pattern[index + 2]).contains(&value);
                index += 3;
            } else {
                matched |= first == value;
                index += 1;
            }
        }
        Some((matched != negated, end + 1))
    }

    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    let (mut pattern_index, mut value_index, mut star, mut retry) = (0, 0, None, 0);
    let mut operations: usize = 0;
    while value_index < value.len() {
        operations += 1;
        if operations > PATTERN_MAX_OPERATIONS {
            return Err("include_pattern_operation_limit".into());
        }
        let matched = match pattern.get(pattern_index) {
            Some(b'?') => Some(pattern_index + 1),
            Some(b'[') => class_match(
                pattern,
                pattern_index + 1,
                value[value_index],
                &mut operations,
            )
            .and_then(|(matched, next)| matched.then_some(next)),
            Some(byte) if *byte == value[value_index] => Some(pattern_index + 1),
            _ => None,
        };
        if operations > PATTERN_MAX_OPERATIONS {
            return Err("include_pattern_operation_limit".into());
        }
        if let Some(next) = matched {
            pattern_index = next;
            value_index += 1;
        } else if pattern.get(pattern_index) == Some(&b'*') {
            star = Some(pattern_index);
            pattern_index += 1;
            retry = value_index;
        } else if let Some(star_index) = star {
            retry += 1;
            value_index = retry;
            pattern_index = star_index + 1;
        } else {
            return Ok(false);
        }
    }
    while pattern.get(pattern_index) == Some(&b'*') {
        operations += 1;
        if operations > PATTERN_MAX_OPERATIONS {
            return Err("include_pattern_operation_limit".into());
        }
        pattern_index += 1;
    }
    Ok(pattern_index == pattern.len())
}

/// Bounded, non-recursive OpenSSH-style `*`/`?` matcher. `[` has no special
/// meaning here (unlike Include filesystem patterns).
#[cfg(test)]
fn ssh_pattern_match(pattern: &str, value: &str, case_sensitive: bool) -> Result<bool, String> {
    ssh_pattern_match_with_budget(pattern, value, case_sensitive, &PatternBudget::new())
}

fn ssh_pattern_match_with_budget(
    pattern: &str,
    value: &str,
    case_sensitive: bool,
    budget: &PatternBudget,
) -> Result<bool, String> {
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    let eq = |a: u8, b: u8| {
        if case_sensitive {
            a == b
        } else {
            a.eq_ignore_ascii_case(&b)
        }
    };
    let (mut pi, mut vi, mut star, mut retry) = (0, 0, None, 0);
    while vi < v.len() {
        budget.charge()?;
        if pi < p.len() && (p[pi] == b'?' || eq(p[pi], v[vi])) {
            pi += 1;
            vi += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            retry = vi;
        } else if let Some(s) = star {
            retry += 1;
            vi = retry;
            pi = s + 1;
        } else {
            return Ok(false);
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        budget.charge()?;
        pi += 1;
    }
    Ok(pi == p.len())
}

fn pattern_list_matches(
    patterns: &[String],
    value: &str,
    case_sensitive: bool,
    budget: &PatternBudget,
) -> Result<bool, String> {
    let mut positive = false;
    for pattern in patterns {
        budget.charge()?;
        let (negated, pattern) = pattern
            .strip_prefix('!')
            .map_or((false, pattern.as_str()), |p| (true, p));
        if ssh_pattern_match_with_budget(pattern, value, case_sensitive, budget)? {
            if negated {
                return Ok(false);
            }
            positive = true;
        }
    }
    Ok(positive)
}

impl<'a> ConfigResolver<'a> {
    fn record_parse_hazard(
        &mut self,
        caller: Option<&LocatedDirective>,
        fallback_source: &str,
        code: &str,
    ) {
        if is_resource_limit(code) {
            self.exhausted = true;
        }
        let hazard = (
            caller.cloned().unwrap_or_else(|| LocatedDirective {
                source: fallback_source.to_string(),
                line: 0,
                key: "Include".into(),
                values: Vec::new(),
            }),
            code.into(),
        );
        if caller.is_some() {
            self.blocks.last_mut().unwrap().hazards.push(hazard);
        } else {
            self.hazards.push(hazard);
        }
    }

    fn new(root: &'a Path, home: &'a Path, limits: ResolverLimits) -> Result<Self, String> {
        let boundary = root
            .parent()
            .unwrap_or(root)
            .canonicalize()
            .map_err(|e| format!("resolve ssh config root failed: {e}"))?;
        Ok(Self {
            home,
            boundary,
            limits,
            files: 0,
            bytes: 0,
            dir_entries: 0,
            expanded_paths: 0,
            stack: Vec::new(),
            blocks: vec![ConfigBlock {
                guards: Vec::new(),
                selector: Selector::Global,
                directives: Vec::new(),
                hazards: Vec::new(),
            }],
            exhausted: false,
            hazards: Vec::new(),
        })
    }

    fn push_block(&mut self, block: ConfigBlock, at: &LocatedDirective) -> bool {
        if self.blocks.len() >= CONFIG_MAX_BLOCKS {
            self.hazards.push((at.clone(), "config_block_limit".into()));
            self.exhausted = true;
            false
        } else {
            self.blocks.push(block);
            true
        }
    }

    fn expand_include_pattern(&mut self, value: &str) -> Result<Vec<PathBuf>, String> {
        if value.contains(['$', '%']) {
            return Err("include_dynamic_expansion_unsupported".into());
        }
        if value.starts_with('~') && value != "~" && !value.starts_with("~/") {
            return Err("include_tilde_user_unsupported".into());
        }
        if value.len() > 4_096 {
            return Err("include_pattern_too_long".into());
        }
        let path = if value == "~" {
            self.home.to_path_buf()
        } else if let Some(rest) = value.strip_prefix("~/") {
            self.home.join(rest)
        } else {
            // OpenSSH anchors relative user-config Includes at ~/.ssh, even
            // when the Include itself occurs in a nested fragment.
            self.boundary.join(value)
        };
        let mut paths = vec![PathBuf::new()];
        let mut expanded_glob = false;
        for component in path.components() {
            let text = component.as_os_str().to_string_lossy();
            if text.contains(['*', '?', '[']) {
                expanded_glob = true;
                let mut next = Vec::new();
                for prefix in paths {
                    if let Ok(entries) = fs::read_dir(&prefix) {
                        for entry in entries {
                            self.dir_entries += 1;
                            if self.dir_entries > self.limits.dir_entries {
                                return Err("include_directory_entry_limit".into());
                            }
                            let entry = entry.map_err(|_| "include_read_failed")?;
                            let name = entry
                                .file_name()
                                .into_string()
                                .map_err(|_| "include_non_utf8_name")?;
                            if name.starts_with('.') && !text.starts_with('.') {
                                continue;
                            }
                            if glob_match(&text, &name)? {
                                next.push(entry.path());
                                self.expanded_paths += 1;
                                if self.expanded_paths > self.limits.expanded_paths {
                                    return Err("include_expanded_path_limit".into());
                                }
                            }
                        }
                    }
                }
                paths = next;
            } else {
                for prefix in &mut paths {
                    prefix.push(component.as_os_str());
                }
            }
        }
        if !expanded_glob {
            self.expanded_paths = self.expanded_paths.saturating_add(paths.len());
            if self.expanded_paths > self.limits.expanded_paths {
                return Err("include_expanded_path_limit".into());
            }
        }
        paths.sort_by(|a, b| {
            a.as_os_str()
                .as_encoded_bytes()
                .cmp(b.as_os_str().as_encoded_bytes())
        });
        Ok(paths)
    }

    fn parse_file(
        &mut self,
        path: &Path,
        depth: usize,
        caller: Option<&LocatedDirective>,
        guards: Vec<Selector>,
    ) {
        let source = path.display().to_string();
        if depth > self.limits.depth {
            self.record_parse_hazard(caller, &source, "include_depth_limit");
            return;
        }
        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(_) => {
                self.record_parse_hazard(caller, &source, "include_read_failed");
                return;
            }
        };
        if !canonical.starts_with(&self.boundary) {
            self.record_parse_hazard(caller, &source, "include_outside_boundary");
            return;
        }
        if self.stack.contains(&canonical) {
            self.record_parse_hazard(caller, &source, "include_cycle");
            return;
        }
        if self.files >= self.limits.files {
            self.record_parse_hazard(caller, &source, "include_file_limit");
            return;
        }
        // Metadata-before-open prevents obvious FIFO/device blocking. There is
        // an unavoidable same-user path-swap TOCTOU on platforms without a
        // portable no-follow open API.
        let metadata = match fs::metadata(&canonical) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => {
                self.record_parse_hazard(caller, &source, "include_not_regular_file");
                return;
            }
            Err(_) => {
                self.record_parse_hazard(caller, &source, "include_read_failed");
                return;
            }
        };
        let remaining = self.limits.bytes.saturating_sub(self.bytes);
        if metadata.len() > remaining as u64 {
            self.record_parse_hazard(caller, &source, "include_byte_limit");
            return;
        }
        self.files += 1; // count before content read, including failed reads
        use std::io::Read;
        let mut bytes = Vec::new();
        let read_result = fs::File::open(&canonical).and_then(|file| {
            file.take((remaining + 1) as u64)
                .read_to_end(&mut bytes)
                .map(|_| ())
        });
        self.bytes = self.bytes.saturating_add(bytes.len());
        if self.bytes > self.limits.bytes {
            self.record_parse_hazard(caller, &source, "include_byte_limit");
            return;
        }
        if read_result.is_err() {
            self.record_parse_hazard(caller, &source, "include_read_failed");
            return;
        }
        let raw = match String::from_utf8(bytes) {
            Ok(raw) => raw,
            Err(_) => {
                self.record_parse_hazard(caller, &source, "include_read_failed");
                return;
            }
        };
        self.stack.push(canonical.clone());
        for (index, line) in raw.lines().enumerate() {
            if self.exhausted {
                break;
            }
            let line_no = index + 1;
            let Some(mut tokens) = ssh_config_tokens(line) else {
                self.blocks.last_mut().unwrap().hazards.push((
                    LocatedDirective {
                        source: source.clone(),
                        line: line_no,
                        key: line.trim().into(),
                        values: vec![],
                    },
                    "malformed_directive".into(),
                ));
                continue;
            };
            if tokens.is_empty() {
                continue;
            }
            let mut key = tokens.remove(0);
            if let Some((left, right)) = key.clone().split_once('=') {
                key = left.into();
                if !right.is_empty() {
                    tokens.insert(0, right.into());
                }
            } else if tokens.first().is_some_and(|v| v == "=") {
                tokens.remove(0);
            } else if let Some(value) = tokens
                .first_mut()
                .and_then(|value| value.strip_prefix('=').map(str::to_string))
            {
                *tokens.first_mut().expect("first token exists") = value;
            }
            let directive = LocatedDirective {
                source: source.clone(),
                line: line_no,
                key: key.clone(),
                values: tokens.clone(),
            };
            match key.to_ascii_lowercase().as_str() {
                "include" => {
                    if tokens.is_empty() {
                        self.blocks
                            .last_mut()
                            .unwrap()
                            .hazards
                            .push((directive, "include_invalid_arguments".into()));
                        continue;
                    }
                    if matches!(
                        self.blocks.last().map(|block| &block.selector),
                        Some(Selector::Match(_))
                    ) {
                        self.blocks
                            .last_mut()
                            .unwrap()
                            .hazards
                            .push((directive, "include_match_context_unsupported".into()));
                        continue;
                    }
                    let outer = self.blocks.last().expect("config block").clone();
                    for pattern in tokens {
                        if self.exhausted {
                            break;
                        }
                        let include_directive = LocatedDirective {
                            source: directive.source.clone(),
                            line: directive.line,
                            key: directive.key.clone(),
                            values: vec![pattern.clone()],
                        };
                        match self.expand_include_pattern(&pattern) {
                            Ok(paths) if !paths.is_empty() => {
                                for included in paths {
                                    if self.exhausted {
                                        break;
                                    }
                                    let mut inherited = outer.guards.clone();
                                    inherited.push(outer.selector.clone());
                                    if !self.push_block(
                                        ConfigBlock {
                                            guards: inherited.clone(),
                                            selector: Selector::Global,
                                            directives: Vec::new(),
                                            hazards: Vec::new(),
                                        },
                                        &include_directive,
                                    ) {
                                        break;
                                    }
                                    self.parse_file(
                                        &included,
                                        depth + 1,
                                        Some(&include_directive),
                                        inherited,
                                    );
                                    // Selectors inside an included file are
                                    // local to that file. Resume the caller's
                                    // exact selector before parsing its next
                                    // directive or the next glob match.
                                    if !self.push_block(
                                        ConfigBlock {
                                            guards: outer.guards.clone(),
                                            selector: outer.selector.clone(),
                                            directives: Vec::new(),
                                            hazards: Vec::new(),
                                        },
                                        &include_directive,
                                    ) {
                                        break;
                                    }
                                }
                            }
                            Ok(_) => self
                                .blocks
                                .last_mut()
                                .unwrap()
                                .hazards
                                .push((include_directive, "include_no_matches".into())),
                            Err(code) => {
                                if is_resource_limit(&code) {
                                    self.exhausted = true;
                                }
                                self.blocks
                                    .last_mut()
                                    .unwrap()
                                    .hazards
                                    .push((include_directive, code));
                            }
                        }
                    }
                }
                "host" => {
                    self.push_block(
                        ConfigBlock {
                            guards: guards.clone(),
                            selector: Selector::Host(tokens),
                            directives: Vec::new(),
                            hazards: Vec::new(),
                        },
                        &directive,
                    );
                }
                "match" => {
                    self.push_block(
                        ConfigBlock {
                            guards: guards.clone(),
                            selector: Selector::Match(directive.clone()),
                            directives: Vec::new(),
                            hazards: Vec::new(),
                        },
                        &directive,
                    );
                }
                _ => self.blocks.last_mut().unwrap().directives.push(directive),
            }
        }
        self.stack.pop();
    }
}

fn match_selector(
    tokens: &[String],
    alias: &str,
    match_host: &str,
    effective: &EffectiveConfig,
    local_user: &str,
    pattern_budget: &PatternBudget,
    phase: MatchPhase,
) -> Result<bool, String> {
    if tokens.is_empty() {
        return Err("match_invalid_arguments".into());
    }
    if tokens.len() == 1 && tokens[0].eq_ignore_ascii_case("all") {
        return Ok(true);
    }
    let mut i = 0;
    let mut result = true;
    let mut criteria_seen = 0;
    while i < tokens.len() {
        let mut criterion = tokens[i].as_str();
        i += 1;
        let negated = criterion.strip_prefix('!').is_some();
        criterion = criterion.strip_prefix('!').unwrap_or(criterion);
        let criterion_lower = criterion.to_ascii_lowercase();
        if matches!(criterion_lower.as_str(), "canonical" | "final") {
            criteria_seen += 1;
            let matched = if criterion_lower == "canonical" {
                phase.canonical
            } else {
                phase.final_pass
            };
            result &= if negated { !matched } else { matched };
            continue;
        }
        if criterion_lower == "all" {
            if negated || i != tokens.len() || criteria_seen > 1 {
                return Err("match_invalid_arguments".into());
            }
            continue;
        }
        if i >= tokens.len() {
            return Err("match_invalid_arguments".into());
        }
        if criterion.eq_ignore_ascii_case("exec") {
            return if result {
                Err("match_exec_unsupported".into())
            } else {
                Ok(false)
            };
        }
        let patterns: Vec<String> = tokens[i].split(',').map(str::to_string).collect();
        i += 1;
        criteria_seen += 1;
        let value = match criterion.to_ascii_lowercase().as_str() {
            "host" => effective
                .host_name
                .as_ref()
                .map(|v| v.0.as_str())
                .unwrap_or(match_host),
            "originalhost" => alias,
            "user" => effective
                .user
                .as_ref()
                .map(|v| v.0.as_str())
                .or_else(|| (!local_user.is_empty()).then_some(local_user))
                .ok_or_else(|| "local_user_unresolved".to_string())?,
            "localuser" if !local_user.is_empty() => local_user,
            "localuser" => return Err("local_user_unresolved".into()),
            _ => return Err("match_predicate_unsupported".into()),
        };
        let case_sensitive = matches!(
            criterion.to_ascii_lowercase().as_str(),
            "user" | "localuser"
        );
        let matched = pattern_list_matches(&patterns, value, case_sensitive, pattern_budget)?;
        result &= if negated { !matched } else { matched };
    }
    Ok(result)
}

fn push_bounded(out: &mut String, value: &str, max_bytes: usize) -> Result<(), String> {
    if out
        .len()
        .checked_add(value.len())
        .is_none_or(|length| length > max_bytes)
    {
        return Err("expanded_value_too_long".into());
    }
    out.push_str(value);
    Ok(())
}

fn expand_value(
    value: &str,
    alias: &str,
    effective: &EffectiveConfig,
    home: &Path,
    local_user: &str,
) -> Result<String, String> {
    if value.contains('$') {
        return Err("environment_expansion_unsupported".into());
    }
    if value.starts_with('~') && value != "~" && !value.starts_with("~/") {
        return Err("tilde_user_expansion_unsupported".into());
    }
    let value = if value == "~" {
        home.display().to_string()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest).display().to_string()
    } else {
        value.to_string()
    };
    let host = effective
        .host_name
        .as_ref()
        .map(|v| v.0.as_str())
        .unwrap_or(alias);
    let user = effective.user.as_ref().map(|v| v.0.as_str()).unwrap_or("");
    let port = effective
        .port
        .as_ref()
        .map(|v| v.0.as_str())
        .unwrap_or("22");
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            let mut encoded = [0_u8; 4];
            push_bounded(&mut out, ch.encode_utf8(&mut encoded), 4_096)?;
            continue;
        }
        let token = chars
            .next()
            .ok_or_else(|| "unknown_percent_token".to_string())?;
        let replacement = match token {
            '%' => "%",
            'h' => host,
            'n' => alias,
            'p' => port,
            'r' => user,
            'u' => local_user,
            _ => return Err("unknown_percent_token".into()),
        };
        if replacement.is_empty() {
            return Err("unresolved_percent_token".into());
        }
        push_bounded(&mut out, replacement, 4_096)?;
    }
    Ok(out)
}

fn expand_hostname(value: &str, alias: &str) -> Result<String, String> {
    if value.contains('$') {
        return Err("environment_expansion_unsupported".into());
    }
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            let mut encoded = [0_u8; 4];
            push_bounded(&mut out, ch.encode_utf8(&mut encoded), 1_024)?;
            continue;
        }
        match chars.next() {
            Some('%') => push_bounded(&mut out, "%", 1_024)?,
            Some('h') => push_bounded(&mut out, alias, 1_024)?,
            Some(_) | None => return Err("hostname_percent_token_unsupported".into()),
        }
    }
    Ok(out)
}

#[cfg(unix)]
fn local_account_name() -> Option<String> {
    use std::ffi::CStr;

    // Match OpenSSH's process-account semantics instead of trusting mutable
    // USER/USERNAME environment variables. Bound the libc-recommended buffer
    // so a pathological account database cannot force an unbounded allocation.
    let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let buffer_len = if suggested > 0 {
        usize::try_from(suggested).ok()?.clamp(1_024, 1024 * 1024)
    } else {
        16 * 1024
    };
    let mut buffer = vec![0_u8; buffer_len];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() {
        return None;
    }
    let entry = unsafe { entry.assume_init() };
    if entry.pw_name.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(entry.pw_name) }
        .to_str()
        .ok()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(not(unix))]
fn local_account_name() -> Option<String> {
    // Do not pretend USERNAME has OS-account authority on Windows. Until the
    // Windows account API is wired, aliases depending on Match localuser,
    // default Match user, or %u are rejected by the empty value.
    None
}

fn requests_final_pass(blocks: &[ConfigBlock]) -> bool {
    blocks.iter().any(|block| {
        block
            .guards
            .iter()
            .chain(std::iter::once(&block.selector))
            .any(|selector| match selector {
                Selector::Match(directive) => {
                    let mut index = 0;
                    while index < directive.values.len() {
                        let criterion = &directive.values[index];
                        index += 1;
                        let (negated, criterion) = criterion
                            .strip_prefix('!')
                            .map_or((false, criterion.as_str()), |value| (true, value));
                        if criterion.eq_ignore_ascii_case("final") {
                            if !negated {
                                return true;
                            }
                            continue;
                        }
                        if criterion.eq_ignore_ascii_case("canonical")
                            || criterion.eq_ignore_ascii_case("all")
                        {
                            continue;
                        }
                        // host/originalhost/user/localuser/exec consume one
                        // argument; a token equal to "final" there is data.
                        index = index.saturating_add(1);
                    }
                    false
                }
                _ => false,
            })
    })
}

struct CnameRule {
    source: Vec<String>,
    target: Vec<String>,
}

struct CanonicalSettings {
    mode: String,
    mode_directive: Option<LocatedDirective>,
    domains: Vec<String>,
    domains_directive: Option<LocatedDirective>,
    max_dots: u8,
    fallback: bool,
    cname_rules: Option<Vec<CnameRule>>,
    cname_directive: Option<LocatedDirective>,
}

fn canonical_settings(
    config: &EffectiveConfig,
) -> Result<CanonicalSettings, (LocatedDirective, String)> {
    let mode = config
        .canonicalize_hostname
        .as_ref()
        .map(|value| value.0.to_ascii_lowercase())
        .unwrap_or_else(|| "no".into());
    if !matches!(mode.as_str(), "no" | "yes" | "always") {
        return Err((
            config.canonicalize_hostname.as_ref().unwrap().1.clone(),
            "canonicalize_hostname_invalid".into(),
        ));
    }
    let max_dots = if let Some((value, directive)) = &config.canonicalize_max_dots {
        value
            .parse::<u8>()
            .map_err(|_| (directive.clone(), "canonicalize_max_dots_invalid".into()))?
    } else {
        1
    };
    let fallback = if let Some((value, directive)) = &config.canonicalize_fallback_local {
        match value.to_ascii_lowercase().as_str() {
            "yes" => true,
            "no" => false,
            _ => {
                return Err((
                    directive.clone(),
                    "canonicalize_fallback_local_invalid".into(),
                ))
            }
        }
    } else {
        true
    };
    let mut domains = config
        .canonical_domains
        .as_ref()
        .map(|value| value.0.clone())
        .unwrap_or_default();
    if domains
        .iter()
        .any(|domain| domain.eq_ignore_ascii_case("none"))
    {
        if domains.len() != 1 {
            return Err((
                config.canonical_domains.as_ref().unwrap().1.clone(),
                "canonical_domains_invalid".into(),
            ));
        }
        domains.clear();
    }
    for domain in &domains {
        if domain.is_empty()
            || domain.len() > 253
            || !domain
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
        {
            return Err((
                config.canonical_domains.as_ref().unwrap().1.clone(),
                "canonical_domain_invalid".into(),
            ));
        }
    }
    let cname_rules = if let Some((values, directive)) = &config.canonicalize_permitted_cnames {
        if values
            .iter()
            .any(|value| value.eq_ignore_ascii_case("none"))
        {
            if values.len() != 1 {
                return Err((
                    directive.clone(),
                    "canonicalize_permitted_cnames_invalid".into(),
                ));
            }
            None
        } else {
            let mut rules = Vec::with_capacity(values.len());
            for value in values {
                let (source, target) = if value == "*" {
                    ("*", "*")
                } else {
                    value.split_once(':').ok_or_else(|| {
                        (
                            directive.clone(),
                            "canonicalize_permitted_cnames_invalid".into(),
                        )
                    })?
                };
                let source = source.split(',').map(str::to_string).collect::<Vec<_>>();
                let target = target.split(',').map(str::to_string).collect::<Vec<_>>();
                if source.iter().any(String::is_empty) || target.iter().any(String::is_empty) {
                    return Err((
                        directive.clone(),
                        "canonicalize_permitted_cnames_invalid".into(),
                    ));
                }
                rules.push(CnameRule { source, target });
            }
            Some(rules)
        }
    } else {
        None
    };
    Ok(CanonicalSettings {
        mode,
        mode_directive: config
            .canonicalize_hostname
            .as_ref()
            .map(|value| value.1.clone()),
        domains,
        domains_directive: config
            .canonical_domains
            .as_ref()
            .map(|value| value.1.clone()),
        max_dots,
        fallback,
        cname_rules,
        cname_directive: config
            .canonicalize_permitted_cnames
            .as_ref()
            .map(|value| value.1.clone()),
    })
}

fn canonicalize_for_second_pass(
    config: &EffectiveConfig,
    current_host: &str,
    lookup: &dyn Fn(&str) -> Result<Option<CanonicalLookup>, String>,
    lookup_count: &Cell<usize>,
    pattern_budget: &PatternBudget,
) -> Result<Option<String>, (LocatedDirective, String)> {
    fn apply_cname_policy(
        settings: &CanonicalSettings,
        source: &str,
        answer: CanonicalLookup,
        pattern_budget: &PatternBudget,
    ) -> Result<String, (LocatedDirective, String)> {
        let Some(rules) = &settings.cname_rules else {
            return Ok(source.to_string());
        };
        let directive = settings
            .cname_directive
            .as_ref()
            .expect("CNAME rules have provenance");
        let Some(canonical_name) = answer
            .canonical_name
            .map(|name| name.trim_end_matches('.').to_string())
        else {
            return Err((directive.clone(), "canonical_cname_unverifiable".into()));
        };
        if canonical_name.eq_ignore_ascii_case(source) {
            return Ok(source.to_string());
        }
        if !valid_resolved_host(&canonical_name) {
            return Err((directive.clone(), "canonical_cname_invalid".into()));
        }
        for rule in rules {
            let source_matches = pattern_list_matches(&rule.source, source, false, pattern_budget)
                .map_err(|code| (directive.clone(), code))?;
            let target_matches =
                pattern_list_matches(&rule.target, &canonical_name, false, pattern_budget)
                    .map_err(|code| (directive.clone(), code))?;
            if source_matches && target_matches {
                return Ok(canonical_name);
            }
        }
        Ok(source.to_string())
    }

    let settings = canonical_settings(config)?;
    if settings.mode == "no" {
        return Ok(None);
    }
    let routed = config
        .proxy_jump
        .as_ref()
        .is_some_and(|value| !value.0.eq_ignore_ascii_case("none"));
    let address_like = current_host.contains(['%', ':'])
        || current_host
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '.');
    if (settings.mode == "yes" && routed)
        || current_host.parse::<std::net::IpAddr>().is_ok()
        || address_like
    {
        return Ok(Some(current_host.to_string()));
    }
    if let Some(anchored) = current_host.strip_suffix('.') {
        let directive = settings
            .mode_directive
            .as_ref()
            .expect("enabled canonicalization has provenance");
        let count = lookup_count.get().saturating_add(1);
        lookup_count.set(count);
        if count > CANONICAL_MAX_LOOKUPS {
            return Err((directive.clone(), "canonical_lookup_limit".into()));
        }
        return match lookup(current_host) {
            Ok(Some(answer)) => {
                apply_cname_policy(&settings, anchored, answer, pattern_budget).map(Some)
            }
            Ok(None) => Err((directive.clone(), "canonicalization_failed".into())),
            Err(code) => Err((directive.clone(), code)),
        };
    }
    let skip_suffix = current_host.matches('.').count() > usize::from(settings.max_dots);
    if !skip_suffix {
        for domain in &settings.domains {
            let candidate = format!("{current_host}.{}", domain.trim_end_matches('.'));
            let directive = settings
                .domains_directive
                .as_ref()
                .expect("canonical domains have provenance");
            if !valid_resolved_host(&candidate) {
                return Err((directive.clone(), "canonicalized_host_invalid".into()));
            }
            let count = lookup_count.get().saturating_add(1);
            lookup_count.set(count);
            if count > CANONICAL_MAX_LOOKUPS {
                return Err((directive.clone(), "canonical_lookup_limit".into()));
            }
            let absolute_candidate = format!("{candidate}.");
            match lookup(&absolute_candidate) {
                Ok(Some(answer)) => {
                    return apply_cname_policy(&settings, &candidate, answer, pattern_budget)
                        .map(Some)
                }
                Ok(None) => (),
                Err(code) => return Err((directive.clone(), code)),
            }
        }
    }
    if !skip_suffix && !settings.fallback {
        return Err((
            config
                .canonicalize_fallback_local
                .as_ref()
                .map(|value| value.1.clone())
                .or_else(|| settings.mode_directive.clone())
                .expect("enabled canonicalization has provenance"),
            "canonicalization_failed".into(),
        ));
    }
    if settings.cname_rules.is_some() {
        let directive = settings
            .cname_directive
            .as_ref()
            .expect("CNAME rules have provenance");
        let count = lookup_count.get().saturating_add(1);
        lookup_count.set(count);
        if count > CANONICAL_MAX_LOOKUPS {
            return Err((directive.clone(), "canonical_lookup_limit".into()));
        }
        match lookup(current_host) {
            Ok(Some(answer)) => {
                return apply_cname_policy(&settings, current_host, answer, pattern_budget)
                    .map(Some)
            }
            Ok(None) if settings.mode == "always" && routed => (),
            Ok(None) => return Err((directive.clone(), "canonicalization_failed".into())),
            Err(code) => return Err((directive.clone(), code)),
        }
    }
    if skip_suffix || settings.fallback {
        Ok(Some(current_host.to_string()))
    } else {
        Err((
            config
                .canonicalize_fallback_local
                .as_ref()
                .map(|value| value.1.clone())
                .or(settings.mode_directive)
                .expect("enabled canonicalization has provenance"),
            "canonicalization_failed".into(),
        ))
    }
}

fn resolve_config_with_lookup(
    root: &Path,
    home: &Path,
    local_user: &str,
    saved_profiles: &[SshHostProfile],
    limits: ResolverLimits,
    lookup: &dyn Fn(&str) -> Result<Option<CanonicalLookup>, String>,
) -> SshImportResult {
    let mut resolver = match ConfigResolver::new(root, home, limits) {
        Ok(r) => r,
        Err(error) => {
            return SshImportResult {
                imported: vec![],
                skipped: 1,
                diagnostics: vec![diagnostic(
                    &root.display().to_string(),
                    0,
                    "<unknown>",
                    "config_root_failed",
                    &error,
                )],
            }
        }
    };
    resolver.parse_file(root, 0, None, Vec::new());
    if resolver.exhausted {
        let (directive, code) = resolver
            .hazards
            .iter()
            .chain(
                resolver
                    .blocks
                    .iter()
                    .flat_map(|block| block.hazards.iter()),
            )
            .find(|(_, code)| is_resource_limit(code))
            .cloned()
            .unwrap_or_else(|| {
                (
                    LocatedDirective {
                        source: root.display().to_string(),
                        line: 0,
                        key: "Include".into(),
                        values: Vec::new(),
                    },
                    "config_resource_limit".into(),
                )
            });
        return SshImportResult {
            imported: Vec::new(),
            skipped: 1,
            diagnostics: vec![diagnostic(
                &directive.source,
                directive.line,
                "<unknown>",
                &code,
                &directive.key,
            )],
        };
    }
    let mut aliases = Vec::new();
    let mut alias_set = std::collections::BTreeSet::new();
    let pattern_exhausted = std::cell::Cell::new(false);
    let pattern_budget = PatternBudget::new();
    'discovery: for block in &resolver.blocks {
        if let Selector::Host(patterns) = &block.selector {
            for p in patterns {
                if pattern_exhausted.get() {
                    break 'discovery;
                }
                let candidate_active = block.guards.iter().all(|guard| match guard {
                    Selector::Global => true,
                    Selector::Host(patterns) => {
                        { pattern_list_matches(patterns, p, false, &pattern_budget) }
                            .unwrap_or_else(|_| {
                                pattern_exhausted.set(true);
                                false
                            })
                    }
                    Selector::Match(d) => match_selector(
                        d.values.as_slice(),
                        p,
                        p,
                        &EffectiveConfig::default(),
                        local_user,
                        &pattern_budget,
                        INITIAL_MATCH_PHASE,
                    )
                    .unwrap_or_else(|code| {
                        if code == "pattern_operation_limit" {
                            pattern_exhausted.set(true);
                        }
                        false
                    }),
                });
                if pattern_exhausted.get() {
                    break 'discovery;
                }
                if candidate_active
                    && !p.starts_with('!')
                    && !p.contains(['*', '?'])
                    && alias_set.insert(p.clone())
                {
                    aliases.push(p.clone());
                    if aliases.len() > CONFIG_MAX_ALIASES {
                        return SshImportResult {
                            imported: Vec::new(),
                            skipped: 1,
                            diagnostics: vec![diagnostic(
                                &root.display().to_string(),
                                0,
                                "<unknown>",
                                "config_alias_limit",
                                "Host",
                            )],
                        };
                    }
                }
            }
        }
    }
    if pattern_exhausted.get() {
        return SshImportResult {
            imported: Vec::new(),
            skipped: aliases.len().max(1),
            diagnostics: vec![diagnostic(
                &root.display().to_string(),
                0,
                "<unknown>",
                "pattern_operation_limit",
                "Host",
            )],
        };
    }
    if aliases.len().saturating_mul(resolver.blocks.len()) > CONFIG_MAX_SELECTOR_EVALUATIONS {
        return SshImportResult {
            imported: Vec::new(),
            skipped: aliases.len().max(1),
            diagnostics: vec![diagnostic(
                &root.display().to_string(),
                0,
                "<unknown>",
                "config_evaluation_limit",
                "Host",
            )],
        };
    }
    let mut resolved = std::collections::BTreeMap::new();
    let mut resolved_hosts = std::collections::BTreeMap::new();
    let final_pass_requested = requests_final_pass(&resolver.blocks);
    let canonical_lookup_count = Cell::new(0);
    let canonical_limit = std::cell::RefCell::new(None);
    'resolution: for alias in &aliases {
        if pattern_exhausted.get() {
            break;
        }
        let mut config = EffectiveConfig::default();
        if let Some((directive, code)) = resolver.hazards.first() {
            config.rejection = Some((directive.clone(), code.clone()));
        }
        let mut pass_host = alias.clone();
        let mut phase = INITIAL_MATCH_PHASE;
        loop {
            for block in &resolver.blocks {
                if pattern_exhausted.get() {
                    break 'resolution;
                }
                let selector_active =
                    |selector: &Selector, config: &EffectiveConfig| match selector {
                        Selector::Global => Ok(true),
                        Selector::Host(patterns) => {
                            pattern_list_matches(patterns, &pass_host, false, &pattern_budget)
                                .map_err(|code| {
                                    pattern_exhausted.set(true);
                                    (
                                        LocatedDirective {
                                            source: root.display().to_string(),
                                            line: 0,
                                            key: "Host".into(),
                                            values: patterns.clone(),
                                        },
                                        code,
                                    )
                                })
                        }
                        Selector::Match(directive) => match_selector(
                            &directive.values,
                            alias,
                            &pass_host,
                            config,
                            local_user,
                            &pattern_budget,
                            phase,
                        )
                        .map_err(|code| {
                            if code == "pattern_operation_limit" {
                                pattern_exhausted.set(true);
                            }
                            (directive.clone(), code)
                        }),
                    };
                let mut active = true;
                for selector in block.guards.iter().chain(std::iter::once(&block.selector)) {
                    match selector_active(selector, &config) {
                        Ok(true) => (),
                        Ok(false) => {
                            active = false;
                            break;
                        }
                        Err((directive, code)) => {
                            config.rejection.get_or_insert((directive, code));
                            active = false;
                            break;
                        }
                    }
                }
                if pattern_exhausted.get() {
                    break 'resolution;
                }
                if !active {
                    continue;
                }
                if let Some((directive, code)) = block.hazards.first() {
                    config
                        .rejection
                        .get_or_insert((directive.clone(), code.clone()));
                }
                for d in &block.directives {
                    let key = d.key.to_ascii_lowercase();
                    if matches!(
                        key.as_str(),
                        "canonicaldomains" | "canonicalizepermittedcnames"
                    ) {
                        if d.values.is_empty() {
                            config
                                .rejection
                                .get_or_insert((d.clone(), "invalid_directive_arguments".into()));
                        } else if key == "canonicaldomains" && config.canonical_domains.is_none() {
                            config.canonical_domains = Some((d.values.clone(), d.clone()));
                        } else if key == "canonicalizepermittedcnames"
                            && config.canonicalize_permitted_cnames.is_none()
                        {
                            config.canonicalize_permitted_cnames =
                                Some((d.values.clone(), d.clone()));
                        }
                        continue;
                    }
                    if d.values.len() != 1 {
                        config
                            .rejection
                            .get_or_insert((d.clone(), "invalid_directive_arguments".into()));
                        continue;
                    }
                    let value = d.values[0].clone();
                    match key.as_str() {
                        "hostname" if config.host_name.is_none() => {
                            match expand_hostname(&value, &pass_host) {
                                Ok(value) => config.host_name = Some((value, d.clone())),
                                Err(code) => {
                                    config.rejection.get_or_insert((d.clone(), code));
                                }
                            }
                        }
                        "user" if config.user.is_none() => {
                            if value.starts_with('~') || value.contains(['%', '$']) {
                                config.rejection.get_or_insert((
                                    d.clone(),
                                    "user_expansion_unsupported".into(),
                                ));
                            } else {
                                config.user = Some((value, d.clone()))
                            }
                        }
                        "port" if config.port.is_none() => config.port = Some((value, d.clone())),
                        "proxyjump" if config.proxy_jump.is_none() => {
                            if value.contains(['$', '~']) {
                                config.rejection.get_or_insert((
                                    d.clone(),
                                    "proxy_jump_expansion_unsupported".into(),
                                ));
                            } else {
                                config.proxy_jump = Some((value, d.clone()))
                            }
                        }
                        "identityfile" => {
                            if config.additive_applied.insert((
                                d.source.clone(),
                                d.line,
                                d.key.to_ascii_lowercase(),
                            )) {
                                config.identities.push((value, d.clone()));
                            }
                        }
                        "certificatefile" => {
                            if config.additive_applied.insert((
                                d.source.clone(),
                                d.line,
                                d.key.to_ascii_lowercase(),
                            )) {
                                config.certificates.push((value, d.clone()));
                            }
                        }
                        "canonicalizehostname" if config.canonicalize_hostname.is_none() => {
                            config.canonicalize_hostname = Some((value, d.clone()));
                        }
                        "canonicalizemaxdots" if config.canonicalize_max_dots.is_none() => {
                            config.canonicalize_max_dots = Some((value, d.clone()));
                        }
                        "canonicalizefallbacklocal"
                            if config.canonicalize_fallback_local.is_none() =>
                        {
                            config.canonicalize_fallback_local = Some((value, d.clone()));
                        }
                        "hostname"
                        | "user"
                        | "port"
                        | "proxyjump"
                        | "canonicalizehostname"
                        | "canonicalizemaxdots"
                        | "canonicalizefallbacklocal" => (),
                        "proxycommand" => {
                            config
                                .rejection
                                .get_or_insert((d.clone(), "unsupported_active_directive".into()));
                        }
                        _ => {
                            config
                                .rejection
                                .get_or_insert((d.clone(), "unknown_active_directive".into()));
                        }
                    }
                }
            }
            if phase.final_pass {
                if let Err((directive, code)) = canonical_settings(&config) {
                    config.rejection.get_or_insert((directive, code));
                }
                break;
            }
            let current_host = config
                .host_name
                .as_ref()
                .map(|value| value.0.clone())
                .unwrap_or_else(|| pass_host.clone());
            match canonicalize_for_second_pass(
                &config,
                &current_host,
                lookup,
                &canonical_lookup_count,
                &pattern_budget,
            ) {
                Ok(Some(canonical_host)) => {
                    let provenance = config
                        .host_name
                        .as_ref()
                        .map(|value| value.1.clone())
                        .unwrap_or_else(|| LocatedDirective {
                            source: root.display().to_string(),
                            line: 0,
                            key: "HostName".into(),
                            values: vec![canonical_host.clone()],
                        });
                    config.host_name = Some((canonical_host.clone(), provenance));
                    pass_host = canonical_host;
                    phase = MatchPhase {
                        canonical: true,
                        final_pass: true,
                    };
                }
                Ok(None) if final_pass_requested => {
                    let provenance = config
                        .host_name
                        .as_ref()
                        .map(|value| value.1.clone())
                        .unwrap_or_else(|| LocatedDirective {
                            source: root.display().to_string(),
                            line: 0,
                            key: "HostName".into(),
                            values: vec![current_host.clone()],
                        });
                    config.host_name = Some((current_host.clone(), provenance));
                    pass_host = current_host;
                    phase = MatchPhase {
                        // OpenSSH uses the same second/final-pass state for
                        // both Match canonical and Match final predicates.
                        canonical: true,
                        final_pass: true,
                    };
                }
                Ok(None) => break,
                Err((directive, code)) => {
                    if is_resource_limit(&code) {
                        *canonical_limit.borrow_mut() = Some((directive, code));
                        break 'resolution;
                    }
                    config.rejection.get_or_insert((directive, code));
                    break;
                }
            }
        }
        let resolved_host = config
            .host_name
            .as_ref()
            .map(|value| value.0.clone())
            .unwrap_or(pass_host);
        if config.host_name.is_none() {
            config.host_name = Some((
                resolved_host.clone(),
                LocatedDirective {
                    source: root.display().to_string(),
                    line: 0,
                    key: "HostName".into(),
                    values: vec![resolved_host.clone()],
                },
            ));
        }
        resolved_hosts.insert(alias.clone(), resolved_host);
        resolved.insert(alias.clone(), config);
    }
    if let Some((directive, code)) = canonical_limit.into_inner() {
        return SshImportResult {
            imported: Vec::new(),
            skipped: aliases.len().max(1),
            diagnostics: vec![diagnostic(
                &directive.source,
                directive.line,
                "<unknown>",
                &code,
                &directive.key,
            )],
        };
    }
    if pattern_exhausted.get() {
        return SshImportResult {
            imported: Vec::new(),
            skipped: aliases.len().max(1),
            diagnostics: vec![diagnostic(
                &root.display().to_string(),
                0,
                "<unknown>",
                "pattern_operation_limit",
                "Host",
            )],
        };
    }
    let mut diagnostics = Vec::new();
    let mut imported = Vec::new();
    let mut synthetic = std::collections::BTreeMap::<String, SshHostProfile>::new();
    let valid_direct_alias = |alias: &str, config: &EffectiveConfig| {
        let host = config
            .host_name
            .as_ref()
            .map(|value| value.0.as_str())
            .or_else(|| resolved_hosts.get(alias).map(String::as_str))
            .unwrap_or(alias);
        let user = config
            .user
            .as_ref()
            .map(|value| value.0.as_str())
            .unwrap_or("");
        config.rejection.is_none()
            && valid_resolved_host(host)
            && valid_resolved_user(user)
            && config
                .proxy_jump
                .as_ref()
                .is_none_or(|value| value.0.eq_ignore_ascii_case("none"))
            && config.identities.len() <= 1
            && config.certificates.len() <= 1
            && (config.certificates.is_empty() || !config.identities.is_empty())
            && config
                .port
                .as_ref()
                .is_none_or(|p| p.0.parse::<u16>().is_ok_and(|port| port > 0))
            && config
                .identities
                .iter()
                .chain(config.certificates.iter())
                .all(|(value, _)| {
                    expand_value(value, alias, config, home, local_user).is_ok_and(|path| {
                        path.len() <= 4_096 && !path.chars().any(char::is_control)
                    })
                })
    };
    let valid_saved_jump = |profile: &SshHostProfile| {
        profile.proxy_jump_profile_id.is_empty()
            && !profile.id.is_empty()
            && valid_resolved_host(&profile.host)
            && valid_resolved_user(&profile.user)
            && profile.port > 0
            && profile.identity_file.len() <= 4_096
            && !profile.identity_file.chars().any(char::is_control)
            && profile.certificate_file.len() <= 4_096
            && !profile.certificate_file.chars().any(char::is_control)
            && (profile.certificate_file.is_empty()
                || (matches!(
                    profile.auth_method,
                    Some(AuthMethod::Key) | Some(AuthMethod::Auto) | None
                ) && !profile.identity_file.is_empty()))
    };
    let saved_jump_has_unique_id = |profile: &SshHostProfile| {
        saved_profiles
            .iter()
            .filter(|saved| saved.id == profile.id)
            .count()
            == 1
            && !aliases.iter().any(|alias| profile_id(alias) == profile.id)
    };
    for alias in &aliases {
        let config = &resolved[alias];
        if let Some((d, code)) = &config.rejection {
            diagnostics.push(diagnostic(&d.source, d.line, alias, code, &d.key));
            continue;
        }
        if config.identities.len() > 1 {
            let d = &config.identities[1].1;
            diagnostics.push(diagnostic(
                &d.source,
                d.line,
                alias,
                "multiple_identity_files_unsupported",
                &d.key,
            ));
            continue;
        }
        if config.certificates.len() > 1 {
            let d = &config.certificates[1].1;
            diagnostics.push(diagnostic(
                &d.source,
                d.line,
                alias,
                "multiple_certificate_files_unsupported",
                &d.key,
            ));
            continue;
        }
        if !config.certificates.is_empty() && config.identities.is_empty() {
            let d = &config.certificates[0].1;
            diagnostics.push(diagnostic(
                &d.source,
                d.line,
                alias,
                "certificate_requires_identity_file",
                &d.key,
            ));
            continue;
        }
        // HostName was expanded exactly once when encountered so emitted '%'
        // bytes remain literal and Match host observes the effective value.
        let host = config
            .host_name
            .as_ref()
            .map(|v| v.0.clone())
            .or_else(|| resolved_hosts.get(alias).cloned())
            .unwrap_or_else(|| alias.clone());
        let user = config
            .user
            .as_ref()
            .map(|value| value.0.clone())
            .unwrap_or_default();
        if !valid_resolved_host(&host) {
            let directive = config.host_name.as_ref().map(|value| &value.1);
            diagnostics.push(diagnostic(
                directive
                    .map(|value| value.source.as_str())
                    .unwrap_or(&root.display().to_string()),
                directive.map(|value| value.line).unwrap_or(0),
                alias,
                "invalid_resolved_host",
                directive.map(|value| value.key.as_str()).unwrap_or("Host"),
            ));
            continue;
        }
        if !valid_resolved_user(&user) {
            let directive = config.user.as_ref().map(|value| &value.1);
            diagnostics.push(diagnostic(
                directive
                    .map(|value| value.source.as_str())
                    .unwrap_or(&root.display().to_string()),
                directive.map(|value| value.line).unwrap_or(0),
                alias,
                "invalid_resolved_user",
                "User",
            ));
            continue;
        }
        let port_raw = config.port.as_ref().map(|p| p.0.as_str()).unwrap_or("22");
        let port = match port_raw.parse::<u16>() {
            Ok(p) if p > 0 => p,
            _ => {
                let d = config.port.as_ref().map(|p| &p.1);
                diagnostics.push(diagnostic(
                    d.map(|x| x.source.as_str())
                        .unwrap_or(&root.display().to_string()),
                    d.map(|x| x.line).unwrap_or(0),
                    alias,
                    "invalid_port",
                    "Port",
                ));
                continue;
            }
        };
        let identity = if let Some((v, d)) = config.identities.first() {
            match expand_value(v, alias, config, home, local_user) {
                Ok(v) => v,
                Err(c) => {
                    diagnostics.push(diagnostic(&d.source, d.line, alias, &c, &d.key));
                    continue;
                }
            }
        } else {
            String::new()
        };
        let certificate = if let Some((v, d)) = config.certificates.first() {
            match expand_value(v, alias, config, home, local_user) {
                Ok(v) => v,
                Err(c) => {
                    diagnostics.push(diagnostic(&d.source, d.line, alias, &c, &d.key));
                    continue;
                }
            }
        } else {
            String::new()
        };
        if identity.len() > 4_096 || identity.chars().any(char::is_control) {
            let directive = &config.identities[0].1;
            diagnostics.push(diagnostic(
                &directive.source,
                directive.line,
                alias,
                "invalid_identity_file_path",
                &directive.key,
            ));
            continue;
        }
        if certificate.len() > 4_096 || certificate.chars().any(char::is_control) {
            let directive = &config.certificates[0].1;
            diagnostics.push(diagnostic(
                &directive.source,
                directive.line,
                alias,
                "invalid_certificate_file_path",
                &directive.key,
            ));
            continue;
        }
        let mut proxy_jump_profile_id = String::new();
        if let Some((raw_jump, d)) = &config.proxy_jump {
            let raw_none = raw_jump.eq_ignore_ascii_case("none");
            let jump = if raw_none {
                raw_jump.clone()
            } else {
                match expand_value(raw_jump, alias, config, home, local_user) {
                    Ok(jump) => jump,
                    Err(code) => {
                        diagnostics.push(diagnostic(&d.source, d.line, alias, &code, &d.key));
                        continue;
                    }
                }
            };
            if raw_none {
                // Explicitly disables inherited routing and remains direct.
            } else if jump.is_empty() || jump.contains(',') {
                diagnostics.push(diagnostic(
                    &d.source,
                    d.line,
                    alias,
                    "proxy_jump_multi_hop",
                    "ProxyJump",
                ));
                continue;
            } else if let Some(jump_config) = resolved.get(&jump) {
                let (code, invalid) = if jump == *alias {
                    ("proxy_jump_cycle", true)
                } else if jump_config
                    .proxy_jump
                    .as_ref()
                    .is_some_and(|value| !value.0.eq_ignore_ascii_case("none"))
                {
                    ("proxy_jump_chain_unsupported", true)
                } else if !valid_direct_alias(&jump, jump_config) {
                    ("proxy_jump_invalid_alias", true)
                } else if saved_profiles
                    .iter()
                    .any(|profile| profile.id == profile_id(&jump))
                {
                    ("proxy_jump_ambiguous", true)
                } else {
                    ("", false)
                };
                if invalid {
                    diagnostics.push(diagnostic(&d.source, d.line, alias, code, "ProxyJump"));
                    continue;
                }
                proxy_jump_profile_id = profile_id(&jump);
            } else if saved_profiles
                .iter()
                .filter(|profile| profile.id == jump)
                .count()
                > 1
            {
                diagnostics.push(diagnostic(
                    &d.source,
                    d.line,
                    alias,
                    "proxy_jump_ambiguous",
                    "ProxyJump",
                ));
                continue;
            } else if saved_profiles
                .iter()
                .filter(|profile| profile.id == jump)
                .count()
                == 1
            {
                let saved = saved_profiles
                    .iter()
                    .find(|profile| profile.id == jump)
                    .expect("unique saved jump id");
                if !valid_saved_jump(saved) || !saved_jump_has_unique_id(saved) {
                    diagnostics.push(diagnostic(
                        &d.source,
                        d.line,
                        alias,
                        "proxy_jump_invalid_saved_profile",
                        "ProxyJump",
                    ));
                    continue;
                }
                proxy_jump_profile_id = saved.id.clone();
            } else if saved_profiles
                .iter()
                .filter(|profile| profile.label == jump)
                .count()
                > 1
            {
                diagnostics.push(diagnostic(
                    &d.source,
                    d.line,
                    alias,
                    "proxy_jump_ambiguous",
                    "ProxyJump",
                ));
                continue;
            } else if saved_profiles
                .iter()
                .filter(|profile| profile.label == jump)
                .count()
                == 1
            {
                let saved = saved_profiles
                    .iter()
                    .find(|profile| profile.label == jump)
                    .expect("unique saved jump label");
                if !valid_saved_jump(saved) || !saved_jump_has_unique_id(saved) {
                    diagnostics.push(diagnostic(
                        &d.source,
                        d.line,
                        alias,
                        "proxy_jump_invalid_saved_profile",
                        "ProxyJump",
                    ));
                    continue;
                }
                proxy_jump_profile_id = saved.id.clone();
            } else if let Some(profile) = literal_jump_profile(&jump) {
                if saved_profiles.iter().any(|saved| saved.id == profile.id)
                    || aliases
                        .iter()
                        .any(|candidate| profile_id(candidate) == profile.id)
                {
                    diagnostics.push(diagnostic(
                        &d.source,
                        d.line,
                        alias,
                        "proxy_jump_ambiguous",
                        "ProxyJump",
                    ));
                    continue;
                }
                proxy_jump_profile_id = profile.id.clone();
                synthetic.entry(profile.id.clone()).or_insert(profile);
            } else {
                diagnostics.push(diagnostic(
                    &d.source,
                    d.line,
                    alias,
                    "proxy_jump_unresolved",
                    "ProxyJump",
                ));
                continue;
            }
        }

        imported.push(SshHostProfile {
            id: profile_id(alias),
            label: alias.clone(),
            host,
            port,
            user,
            auth_method: (!identity.is_empty()).then_some(AuthMethod::Key),
            identity_file: identity,
            certificate_file: certificate,
            proxy_jump_profile_id,
        });
    }
    imported.splice(0..0, synthetic.into_values());
    if aliases.is_empty() {
        diagnostics.extend(resolver.hazards.iter().map(|(directive, code)| {
            diagnostic(
                &directive.source,
                directive.line,
                "<unknown>",
                code,
                &directive.key,
            )
        }));
    }
    SshImportResult {
        imported,
        skipped: diagnostics.len().max(usize::from(
            !resolver.hazards.is_empty() && aliases.is_empty(),
        )),
        diagnostics,
    }
}

#[cfg(unix)]
fn system_canonical_lookup(host: &str) -> Result<Option<CanonicalLookup>, String> {
    use std::ffi::{CStr, CString};

    let host = CString::new(host).map_err(|_| "canonical_dns_name_invalid".to_string())?;
    let mut hints = unsafe { std::mem::zeroed::<libc::addrinfo>() };
    hints.ai_family = libc::AF_UNSPEC;
    hints.ai_socktype = libc::SOCK_STREAM;
    hints.ai_flags = libc::AI_CANONNAME;
    let mut result = std::ptr::null_mut();
    let status = unsafe { libc::getaddrinfo(host.as_ptr(), std::ptr::null(), &hints, &mut result) };
    if status != 0 || result.is_null() {
        return Ok(None);
    }
    let canonical_name = unsafe {
        let value = (*result).ai_canonname;
        (!value.is_null())
            .then(|| CStr::from_ptr(value).to_str().ok().map(str::to_string))
            .flatten()
    };
    unsafe { libc::freeaddrinfo(result) };
    Ok(Some(CanonicalLookup { canonical_name }))
}

#[cfg(not(unix))]
fn system_canonical_lookup(host: &str) -> Result<Option<CanonicalLookup>, String> {
    use std::net::ToSocketAddrs;

    Ok((host, 22)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .map(|_| CanonicalLookup {
            // The standard resolver does not expose CNAME provenance here;
            // non-`none` permitted-CNAME policies therefore fail closed.
            canonical_name: None,
        }))
}

fn resolve_config(
    root: &Path,
    home: &Path,
    local_user: &str,
    saved_profiles: &[SshHostProfile],
    limits: ResolverLimits,
) -> SshImportResult {
    resolve_config_with_lookup(
        root,
        home,
        local_user,
        saved_profiles,
        limits,
        &system_canonical_lookup,
    )
}

#[cfg(test)]
pub(crate) fn parse_ssh_config(raw: &str) -> SshImportResult {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tunara-inline-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = fs::create_dir_all(&dir);
    let root = dir.join("config");
    let _ = fs::write(&root, raw);
    let result = resolve_config(
        &root,
        Path::new("~"),
        "test-local-user",
        &[],
        ResolverLimits::default(),
    );
    let _ = fs::remove_dir_all(dir);
    result
}

#[tauri::command]
pub fn ssh_hosts_import_config() -> Result<SshImportResult, String> {
    (|| {
        let path = ssh_config_path()?;
        if !path.exists() {
            return Ok(SshImportResult {
                imported: Vec::new(),
                skipped: 0,
                diagnostics: Vec::new(),
            });
        }
        let saved = read_hosts(&hosts_path()?)?;
        let home = path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "invalid ssh config path".to_string())?;
        let local_user = local_account_name().unwrap_or_default();
        Ok(resolve_config(
            &path,
            home,
            &local_user,
            &saved,
            ResolverLimits::default(),
        ))
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Hosts, error)
    })
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
        std::fs::canonicalize(std::env::temp_dir())
            .unwrap_or_else(|_| std::env::temp_dir())
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
            auth_method: Some(AuthMethod::Key),
            identity_file: "~/.ssh/id_ed25519".into(),
            certificate_file: "~/.ssh/id_ed25519-cert.pub".into(),
            proxy_jump_profile_id: String::new(),
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

        let prod = result
            .imported
            .iter()
            .find(|p| p.id == "ssh-config-prod")
            .unwrap();
        assert_eq!(prod.host, "prod.example.com");
        assert_eq!(prod.user, "deploy");
        assert_eq!(prod.port, 2222);
        assert_eq!(prod.identity_file, "~/.ssh/id_prod");
        assert_eq!(prod.auth_method, Some(AuthMethod::Key));
        assert_eq!(prod.label, "prod");

        let dev = result
            .imported
            .iter()
            .find(|p| p.id == "ssh-config-dev")
            .unwrap();
        assert_eq!(dev.host, "10.0.0.5");
        assert_eq!(dev.user, "root");
        assert_eq!(dev.port, 22); // absent → default
        assert_eq!(dev.auth_method, None);
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
    fn parse_ssh_config_applies_host_patterns_and_match() {
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
        assert_eq!(result.imported.len(), 2);
        assert!(result
            .imported
            .iter()
            .all(|profile| profile.user == "wildcard"));
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
    fn parse_ssh_config_malformed_port_fails_closed() {
        let raw = "Host badport\n  HostName x\n  Port notanumber\n";
        let result = parse_ssh_config(raw);
        assert!(result.imported.is_empty());
        assert_eq!(result.diagnostics[0].alias, "badport");
        assert_eq!(result.diagnostics[0].line, 3);
        assert_eq!(result.diagnostics[0].code, "invalid_port");
        assert_eq!(result.diagnostics[0].directive, "Port");
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
        assert!(result.imported.is_empty());
        // Include may change first-value resolution for every alias and must
        // not be flattened into an apparently direct profile.
        assert_eq!(result.skipped, 1);
        assert!(result.diagnostics[0].source.ends_with("/config"));
        assert_eq!(result.diagnostics[0].line, 2);
        assert_eq!(result.diagnostics[0].alias, "real");
        assert_eq!(result.diagnostics[0].code, "include_no_matches");
        assert_eq!(result.diagnostics[0].directive, "Include");
    }

    #[test]
    fn parse_ssh_config_skips_hosts_with_unsupported_connection_semantics() {
        let raw = "\
Host direct
  HostName direct.example.com
  User deploy

Host bastion-only
  HostName private.example.com
  ProxyJump jump.example.com
  User deploy

Host aliased-key
  HostName host.example.com
  HostKeyAlias canonical.example.com
";
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].label, "direct");
        assert_eq!(result.skipped, 2);
    }

    #[test]
    fn parse_ssh_config_handles_inline_comments_quotes_and_equals() {
        let raw = r#"
Host="quoted host" other # two aliases, not a comment in quotes
  HostName = real.example.com # trailing comment
  User "deploy_user"
  IdentityFile "~/.ssh/id with spaces"
"#;
        let result = parse_ssh_config(raw);
        assert_eq!(result.imported.len(), 2);
        let quoted = result
            .imported
            .iter()
            .find(|profile| profile.label == "quoted host")
            .expect("quoted alias imported");
        assert_eq!(quoted.host, "real.example.com");
        assert_eq!(quoted.user, "deploy_user");
        assert_eq!(quoted.identity_file, "~/.ssh/id with spaces");
    }

    #[test]
    fn tokenizer_preserves_mid_token_comments_unknown_escapes_and_equals_separator() {
        assert_eq!(
            ssh_config_tokens("HostName foo#bar # comment").unwrap(),
            vec!["HostName", "foo#bar"]
        );
        assert_eq!(
            ssh_config_tokens(r"IdentityFile ~/.ssh/id\q").unwrap(),
            vec!["IdentityFile", r"~/.ssh/id\q"]
        );
        let separated = parse_ssh_config("Host target\n  HostName =target.example\n");
        assert_eq!(separated.imported[0].host, "target.example");
    }

    #[test]
    fn parse_ssh_config_skips_unfinished_quoted_lines() {
        let result = parse_ssh_config("Host good\n  HostName good.example\nHost \"broken\n");
        assert!(result.imported.is_empty());
        assert_eq!(result.skipped, 1);
        assert_eq!(result.diagnostics[0].alias, "good");
        assert_eq!(result.diagnostics[0].line, 3);
    }

    #[test]
    fn parse_ssh_config_resolves_safe_single_hop_alias() {
        let result = parse_ssh_config(
            "Host jump\n  HostName jump.example\n  User ops\n\nHost target\n  HostName private.example\n  ProxyJump jump\n",
        );
        assert_eq!(result.skipped, 0);
        assert_eq!(result.imported.len(), 2);
        let target = result
            .imported
            .iter()
            .find(|profile| profile.label == "target")
            .unwrap();
        assert_eq!(target.proxy_jump_profile_id, "ssh-config-jump");
    }

    #[test]
    fn parse_ssh_config_creates_deterministic_literal_jump_profile() {
        let raw = "Host target\n  HostName private.example\n  ProxyJump ops@jump.example:2222\n";
        let first = parse_ssh_config(raw);
        let second = parse_ssh_config(raw);
        assert_eq!(first.skipped, 0);
        assert_eq!(first.imported.len(), 2);
        let target = first
            .imported
            .iter()
            .find(|profile| profile.label == "target")
            .unwrap();
        let jump = first
            .imported
            .iter()
            .find(|profile| profile.id == target.proxy_jump_profile_id)
            .unwrap();
        assert_eq!(jump.host, "jump.example");
        assert_eq!(jump.port, 2222);
        assert_eq!(jump.user, "ops");
        assert_eq!(first.imported[0].id, second.imported[0].id);
    }

    #[test]
    fn parse_ssh_config_rejects_multi_hop_chain_and_cycle_per_alias() {
        let result = parse_ssh_config(
            "Host a\n  ProxyJump b\nHost b\n  ProxyJump a\nHost many\n  ProxyJump a,b\n",
        );
        assert!(result.imported.is_empty());
        assert!(result
            .diagnostics
            .iter()
            .any(|item| item.alias == "a" && item.code == "proxy_jump_chain_unsupported"));
        assert!(result
            .diagnostics
            .iter()
            .any(|item| item.alias == "b" && item.code == "proxy_jump_chain_unsupported"));
        assert!(result
            .diagnostics
            .iter()
            .any(|item| item.alias == "many" && item.code == "proxy_jump_multi_hop"));
    }

    #[test]
    fn parse_ssh_config_rejects_global_unknown_and_token_semantics() {
        let global = parse_ssh_config("User global\nHost target\n  HostName target.example\n");
        assert_eq!(global.imported[0].user, "global");

        let token = parse_ssh_config("Host target\n  HostName %n.example\n");
        assert!(token.imported.is_empty());
        assert_eq!(
            token.diagnostics[0].code,
            "hostname_percent_token_unsupported"
        );
    }

    #[test]
    fn parse_ssh_config_keeps_first_scalar_and_rejects_additive_identity() {
        let scalar =
            parse_ssh_config("Host target\n  HostName first.example\n  HostName second.example\n");
        assert_eq!(scalar.imported[0].host, "first.example");

        let identities =
            parse_ssh_config("Host target\n  IdentityFile ~/.ssh/one\n  IdentityFile ~/.ssh/two\n");
        assert!(identities.imported.is_empty());
        assert_eq!(
            identities.diagnostics[0].code,
            "multiple_identity_files_unsupported"
        );
    }

    #[test]
    fn parse_ssh_config_imports_certificate_with_private_key() {
        let result = parse_ssh_config(
            "Host certified\n  HostName certified.example\n  IdentityFile ~/.ssh/id_ed25519\n  CertificateFile ~/.ssh/id_ed25519-cert.pub\n",
        );
        assert_eq!(result.skipped, 0);
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].auth_method, Some(AuthMethod::Key));
        assert_eq!(result.imported[0].identity_file, "~/.ssh/id_ed25519");
        assert_eq!(
            result.imported[0].certificate_file,
            "~/.ssh/id_ed25519-cert.pub"
        );
    }

    #[test]
    fn parse_ssh_config_rejects_certificate_without_private_key() {
        let result = parse_ssh_config(
            "Host certified\n  HostName certified.example\n  CertificateFile ~/.ssh/id_ed25519-cert.pub\n",
        );
        assert!(result.imported.is_empty());
        assert_eq!(result.skipped, 1);
        assert!(result.diagnostics[0].source.ends_with("/config"));
        assert_eq!(result.diagnostics[0].line, 3);
        assert_eq!(result.diagnostics[0].alias, "certified");
        assert_eq!(
            result.diagnostics[0].code,
            "certificate_requires_identity_file"
        );
        assert_eq!(result.diagnostics[0].directive, "CertificateFile");
    }

    #[test]
    fn parse_ssh_config_rejects_multiple_certificate_files() {
        let result = parse_ssh_config(
            "Host certified\n  IdentityFile ~/.ssh/id_ed25519\n  CertificateFile ~/.ssh/one-cert.pub\n  CertificateFile ~/.ssh/two-cert.pub\n",
        );
        assert!(result.imported.is_empty());
        assert_eq!(result.diagnostics[0].line, 4);
        assert_eq!(
            result.diagnostics[0].code,
            "multiple_certificate_files_unsupported"
        );
        assert_eq!(result.diagnostics[0].directive, "CertificateFile");
    }

    #[test]
    fn parse_ssh_config_rejects_dangling_or_ambiguous_jump_profiles() {
        let invalid = parse_ssh_config("Host jump\n  Port bad\nHost target\n  ProxyJump jump\n");
        assert!(invalid.imported.is_empty());
        assert!(invalid
            .diagnostics
            .iter()
            .any(|item| item.alias == "target" && item.code == "proxy_jump_invalid_alias"));

        assert!(literal_jump_profile("user@host:22:33").is_none());
        let parsed = literal_jump_profile("a@b@host:22").unwrap();
        assert_eq!(parsed.user, "a@b");
        assert_eq!(parsed.host, "host");
    }

    #[test]
    fn resolver_expands_includes_in_order_with_provenance_and_bounds() {
        let root = temp_path("includes").parent().unwrap().to_path_buf();
        fs::create_dir_all(root.join("conf.d")).unwrap();
        fs::write(root.join("config"), "Include conf.d/*\n").unwrap();
        fs::write(root.join("conf.d/20-b"), "Host target\n  User second\n").unwrap();
        fs::write(root.join("conf.d/10-a"), "Host target\n  User first\n").unwrap();
        let result = resolve_config(
            &root.join("config"),
            &root,
            "test-user",
            &[],
            ResolverLimits::default(),
        );
        assert_eq!(result.imported[0].user, "first");

        fs::write(root.join("conf.d/10-a"), "Include config\nHost target\n").unwrap();
        let cycle = resolve_config(
            &root.join("config"),
            &root,
            "test-user",
            &[],
            ResolverLimits::default(),
        );
        assert_eq!(cycle.diagnostics[0].code, "include_cycle");
        assert!(cycle.diagnostics[0].source.ends_with("/conf.d/10-a"));
        assert_eq!(cycle.diagnostics[0].line, 1);
        assert_eq!(cycle.diagnostics[0].directive, "Include");

        fs::write(root.join("config"), "Host target\nInclude conf.d/*\n").unwrap();
        let limited = resolve_config(
            &root.join("config"),
            &root,
            "test-user",
            &[],
            ResolverLimits {
                depth: 8,
                files: 1,
                bytes: 1024,
                ..ResolverLimits::default()
            },
        );
        assert_eq!(limited.diagnostics[0].code, "include_file_limit");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn literal_include_paths_and_failed_utf8_reads_consume_budgets() {
        let root = temp_path("include-accounting")
            .parent()
            .unwrap()
            .to_path_buf();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("one"), "").unwrap();
        fs::write(root.join("two"), "").unwrap();
        fs::write(root.join("config"), "Include one two\nHost target\n").unwrap();
        let paths = resolve_config(
            &root.join("config"),
            &root,
            "local-user",
            &[],
            ResolverLimits {
                expanded_paths: 1,
                ..ResolverLimits::default()
            },
        );
        assert!(paths.imported.is_empty());
        assert!(paths
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "include_expanded_path_limit"));

        fs::write(root.join("bad-one"), [0xff, 0xff, 0xff, 0xff]).unwrap();
        fs::write(root.join("bad-two"), [0xff, 0xff, 0xff, 0xff]).unwrap();
        let root_config = "Include bad-one bad-two\nHost target\n";
        let config_path = root.join("config");
        fs::write(&config_path, root_config).unwrap();
        let mut resolver = ConfigResolver::new(
            &config_path,
            &root,
            ResolverLimits {
                bytes: root_config.len() + 6,
                ..ResolverLimits::default()
            },
        )
        .unwrap();
        resolver.parse_file(&config_path, 0, None, Vec::new());
        assert_eq!(resolver.bytes, root_config.len() + 4);
        assert!(resolver
            .blocks
            .iter()
            .flat_map(|block| &block.hazards)
            .any(|(_, code)| code == "include_byte_limit"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patterns_matches_and_unsafe_active_blocks_fail_closed() {
        let result = parse_ssh_config(
            "Host * !blocked\n  User common\nHost blocked good\n  HostName %h.example\nMatch originalhost good\n  Port 2222\nHost never\n  ProxyCommand dangerous\n",
        );
        let good = result.imported.iter().find(|p| p.label == "good").unwrap();
        assert_eq!(good.host, "good.example");
        assert_eq!(good.user, "common");
        assert_eq!(good.port, 2222);
        assert!(result
            .imported
            .iter()
            .any(|p| p.label == "blocked" && p.user.is_empty()));
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.alias == "never" && d.directive == "ProxyCommand"));

        let exec = parse_ssh_config("Host target\nMatch exec true\n  User unsafe\n");
        assert_eq!(exec.diagnostics[0].code, "match_exec_unsupported");
        assert_eq!(exec.diagnostics[0].line, 2);
    }

    #[test]
    fn inactive_include_and_unsafe_blocks_do_not_poison_other_aliases() {
        let result = parse_ssh_config(
            "Host missing\n  Include does-not-exist\n  ProxyCommand dangerous\nHost safe\n  HostName safe.example\nMatch originalhost absent exec dangerous\n  User unsafe\n",
        );
        let safe = result.imported.iter().find(|p| p.label == "safe").unwrap();
        assert_eq!(safe.host, "safe.example");
        assert!(result.diagnostics.iter().all(|d| d.alias != "safe"));
        assert!(result
            .diagnostics
            .iter()
            .any(|d| d.alias == "missing" && d.code == "include_read_failed"));

        let dynamic = parse_ssh_config("Host target\n  Include conf/%h\n");
        assert_eq!(
            dynamic.diagnostics[0].code,
            "include_dynamic_expansion_unsupported"
        );
        let matched =
            parse_ssh_config("Host target\nMatch originalhost target\n  Include conf/target\n");
        assert_eq!(
            matched.diagnostics[0].code,
            "include_match_context_unsupported"
        );
    }

    #[test]
    fn ssh_patterns_treat_brackets_literally_and_include_globs_do_not() {
        assert!(ssh_pattern_match("web[0-9]", "web[0-9]", false).unwrap());
        assert!(!ssh_pattern_match("web[0-9]", "web7", false).unwrap());
        assert!(ssh_pattern_match("WEB?", "web7", false).unwrap());
        assert!(glob_match("web[0-9]", "web7").unwrap());
        assert!(!glob_match("WEB[a-c]", "webB").unwrap());
    }

    #[test]
    fn pattern_evaluation_is_bounded_and_fails_the_import_closed() {
        let patterns = std::iter::repeat_n("no-match", PATTERN_MAX_OPERATIONS)
            .collect::<Vec<_>>()
            .join(" ");
        let result = parse_ssh_config(&format!(
            "Host target\n  HostName target.example\nHost {patterns}\n"
        ));
        assert!(result.imported.is_empty());
        assert!(result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "pattern_operation_limit"));

        assert_eq!(
            glob_match(&format!("[{}]", "a".repeat(PATTERN_MAX_OPERATIONS)), "a").unwrap_err(),
            "include_pattern_operation_limit"
        );
    }

    #[test]
    fn safe_tokens_expand_and_unknown_or_environment_tokens_reject() {
        let safe = parse_ssh_config(
            "Host box\n  User alice\n  Port 2200\n  IdentityFile ~/.ssh/%n-%r-%p-%%\n",
        );
        assert_eq!(safe.imported[0].identity_file, "~/.ssh/box-alice-2200-%");
        for value in ["$HOME/key", "%x"] {
            let result = parse_ssh_config(&format!("Host box\n  IdentityFile {value}\n"));
            assert!(result.imported.is_empty());
        }

        let alias = "a".repeat(600);
        let host = parse_ssh_config(&format!("Host {alias}\n  HostName %h%h\n"));
        assert!(host.imported.is_empty());
        assert_eq!(host.diagnostics[0].code, "expanded_value_too_long");

        let effective = EffectiveConfig {
            host_name: Some((
                "h".repeat(1_024),
                LocatedDirective {
                    source: "test".into(),
                    line: 1,
                    key: "HostName".into(),
                    values: Vec::new(),
                },
            )),
            ..EffectiveConfig::default()
        };
        assert_eq!(
            expand_value("%h%h%h%h%h", "box", &effective, Path::new("~"), "local").unwrap_err(),
            "expanded_value_too_long"
        );
    }

    #[test]
    fn include_restores_outer_selector_and_anchors_nested_relative_paths() {
        let root = temp_path("include-scope").parent().unwrap().to_path_buf();
        fs::create_dir_all(root.join("conf.d")).unwrap();
        fs::write(
            root.join("config"),
            "Host target\n  Include conf.d/fragment\n  User outer\nHost *\n  Include conf.d/nested\n",
        )
        .unwrap();
        fs::write(
            root.join("conf.d/fragment"),
            "Host child\n  User child-user\n",
        )
        .unwrap();
        fs::write(root.join("conf.d/nested"), "Include shared\n").unwrap();
        fs::write(root.join("shared"), "Host shared\n  User shared-user\n").unwrap();

        let result = resolve_config(
            &root.join("config"),
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
        );
        let target = result
            .imported
            .iter()
            .find(|profile| profile.label == "target")
            .unwrap();
        assert_eq!(target.user, "outer");
        assert!(!result
            .imported
            .iter()
            .any(|profile| profile.label == "child"));
        assert!(result
            .imported
            .iter()
            .any(|profile| profile.label == "shared" && profile.user == "shared-user"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn match_observes_expanded_hostname_and_supports_final_phase() {
        let matched = parse_ssh_config(
            "Host box\n  HostName %h.example\nMatch host box.example\n  User matched\n",
        );
        assert_eq!(matched.imported[0].host, "box.example");
        assert_eq!(matched.imported[0].user, "matched");

        let user_tilde = parse_ssh_config("Host box\n  User ~\n");
        assert_eq!(user_tilde.diagnostics[0].code, "user_expansion_unsupported");

        let final_phase = parse_ssh_config(
            "Host box\nMatch final\n  User unsafe\nMatch canonical\n  Port 2202\n",
        );
        assert_eq!(final_phase.imported[0].user, "unsafe");
        assert_eq!(final_phase.imported[0].port, 2202);

        let final_hostname = parse_ssh_config(
            "CanonicalizeHostname no\nHost box\nMatch final\n  HostName evil.example\n",
        );
        assert_eq!(final_hostname.imported[0].host, "box");

        for selector in ["Match host final", "Match !final"] {
            let no_reparse = parse_ssh_config(&format!(
                "Host box\n  HostName renamed\nHost renamed\n  Port 2202\n{selector}\n"
            ));
            let profile = no_reparse
                .imported
                .iter()
                .find(|profile| profile.label == "box")
                .unwrap();
            assert_eq!(profile.port, 22);
        }

        let empty = parse_ssh_config("Host box\nMatch\n  HostName unsafe.example\n");
        assert!(empty.imported.is_empty());
        assert_eq!(empty.diagnostics[0].code, "match_invalid_arguments");

        for invalid_match in [
            "Match host box final all",
            "Match host box originalhost box all",
        ] {
            let invalid =
                parse_ssh_config(&format!("Host box\n{invalid_match}\n  User attacker\n"));
            assert!(invalid.imported.is_empty());
            assert!(invalid
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "match_invalid_arguments"));
        }

        assert_eq!(
            expand_value(
                "%u",
                "box",
                &EffectiveConfig::default(),
                Path::new("~"),
                "local%user",
            )
            .unwrap(),
            "local%user"
        );
    }

    #[test]
    fn canonicalization_reparses_with_first_value_semantics() {
        let root = temp_path("canonical-two-pass")
            .parent()
            .unwrap()
            .to_path_buf();
        fs::create_dir_all(&root).unwrap();
        let config_path = root.join("config");
        fs::write(
            &config_path,
            "CanonicalizeHostname yes\nCanonicalDomains example.com\nCanonicalizeFallbackLocal no\nCanonicalizeMaxDots 1\nCanonicalizePermittedCNAMEs none\nHost box\n  User first\nHost box.example.com\n  Port 2201\nMatch canonical host box.example.com\n  IdentityFile ~/.ssh/canonical\n  User second\nMatch final\n  CertificateFile ~/.ssh/canonical-cert.pub\n",
        )
        .unwrap();
        let result = resolve_config_with_lookup(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
            &|host| {
                Ok((host == "box.example.com.").then(|| CanonicalLookup {
                    canonical_name: Some("box.example.com".into()),
                }))
            },
        );
        let profile = result
            .imported
            .iter()
            .find(|profile| profile.label == "box")
            .unwrap_or_else(|| panic!("canonical import failed: {:?}", result.diagnostics));
        assert_eq!(profile.host, "box.example.com");
        assert_eq!(profile.user, "first");
        assert_eq!(profile.port, 2201);
        assert_eq!(
            profile.identity_file,
            root.join(".ssh/canonical").display().to_string()
        );
        assert_eq!(
            profile.certificate_file,
            root.join(".ssh/canonical-cert.pub").display().to_string()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canonicalization_skip_fallback_and_cname_boundaries_fail_closed() {
        let max_dots = parse_ssh_config(
            "CanonicalizeHostname yes\nCanonicalDomains invalid\nCanonicalizeFallbackLocal no\nCanonicalizeMaxDots 0\nHost box.example\nMatch canonical\n  User canonical\n",
        );
        let profile = max_dots
            .imported
            .iter()
            .find(|profile| profile.label == "box.example")
            .unwrap();
        assert_eq!(profile.host, "box.example");
        assert_eq!(profile.user, "canonical");

        let fallback = parse_ssh_config(
            "CanonicalizeHostname yes\nCanonicalDomains invalid\nCanonicalizeFallbackLocal no\nHost definitely-not-resolvable-tunara\n",
        );
        assert!(fallback.imported.is_empty());
        assert!(fallback
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "canonicalization_failed"));

        let invalid_while_disabled = parse_ssh_config(
            "CanonicalizeHostname no\nCanonicalizeFallbackLocal maybe\nHost box\n",
        );
        assert!(invalid_while_disabled.imported.is_empty());
        assert_eq!(
            invalid_while_disabled.diagnostics[0].code,
            "canonicalize_fallback_local_invalid"
        );

        let root = temp_path("canonical-cname").parent().unwrap().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        let config_path = root.join("config");
        fs::write(
            &config_path,
            "CanonicalizeHostname yes\nCanonicalDomains example.com\nCanonicalizeFallbackLocal no\nCanonicalizePermittedCNAMEs *.example.com:target.example.com\nHost cname\nHost target.example.com\n  Port 2223\n",
        )
        .unwrap();
        let cname = resolve_config_with_lookup(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
            &|host| {
                Ok((host == "cname.example.com.").then(|| CanonicalLookup {
                    canonical_name: Some("target.example.com.".into()),
                }))
            },
        );
        let cname_profile = cname
            .imported
            .iter()
            .find(|profile| profile.label == "cname")
            .unwrap();
        assert_eq!(cname_profile.host, "target.example.com");
        assert_eq!(cname_profile.port, 2223);

        fs::write(
            &config_path,
            "CanonicalizeHostname yes\nCanonicalDomains none\nCanonicalizeFallbackLocal yes\nCanonicalizePermittedCNAMEs *\nHost cname\nHost target.example.com\n  Port 2223\n",
        )
        .unwrap();
        let bare_cname = resolve_config_with_lookup(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
            &|host| {
                Ok((host == "cname").then(|| CanonicalLookup {
                    canonical_name: Some("target.example.com".into()),
                }))
            },
        );
        let bare_profile = bare_cname
            .imported
            .iter()
            .find(|profile| profile.label == "cname")
            .unwrap();
        assert_eq!(bare_profile.host, "target.example.com");
        assert_eq!(bare_profile.port, 2223);

        fs::write(
            &config_path,
            "CanonicalizeHostname yes\nCanonicalDomains example.com\nCanonicalizeFallbackLocal no\nCanonicalizePermittedCNAMEs *\nHost cname\n",
        )
        .unwrap();
        let no_fallback = resolve_config_with_lookup(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
            &|host| {
                Ok((host == "cname").then(|| CanonicalLookup {
                    canonical_name: Some("target.example.com".into()),
                }))
            },
        );
        assert!(no_fallback.imported.is_empty());
        assert_eq!(no_fallback.diagnostics[0].code, "canonicalization_failed");

        fs::write(
            &config_path,
            "CanonicalizeHostname yes\nCanonicalDomains none\nCanonicalizeFallbackLocal yes\nCanonicalizePermittedCNAMEs *\nHost missing\n",
        )
        .unwrap();
        let bare_missing = resolve_config_with_lookup(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
            &|_| Ok(None),
        );
        assert!(bare_missing.imported.is_empty());
        assert_eq!(bare_missing.diagnostics[0].code, "canonicalization_failed");

        fs::write(
            &config_path,
            "CanonicalizeHostname yes\nCanonicalDomains example.com\nHost 123 box.\n",
        )
        .unwrap();
        let anchored = resolve_config_with_lookup(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
            &|host| {
                Ok((host == "box.").then(|| CanonicalLookup {
                    canonical_name: Some("box.".into()),
                }))
            },
        );
        assert!(anchored
            .imported
            .iter()
            .any(|profile| profile.label == "123" && profile.host == "123"));
        assert!(anchored
            .imported
            .iter()
            .any(|profile| profile.label == "box." && profile.host == "box"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn declared_final_pass_fields_match_openssh_g() {
        let root = temp_path("ssh-g-final").parent().unwrap().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        let config_path = root.join("config");
        fs::write(
            &config_path,
            "CanonicalizeHostname no\nHost box\n  User first\nMatch final host box\n  Port 2202\n",
        )
        .unwrap();
        let ours = resolve_config(
            &config_path,
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
        );
        let profile = ours
            .imported
            .iter()
            .find(|profile| profile.label == "box")
            .unwrap();
        let output = match std::process::Command::new("ssh")
            .args(["-G", "-F"])
            .arg(&config_path)
            .arg("box")
            .output()
        {
            Ok(output) if output.status.success() => output,
            _ => {
                fs::remove_dir_all(root).unwrap();
                return;
            }
        };
        let rendered = String::from_utf8(output.stdout).unwrap();
        let field = |name: &str| {
            rendered.lines().find_map(|line| {
                let (key, value) = line.split_once(' ')?;
                (key == name).then_some(value)
            })
        };
        assert_eq!(field("hostname"), Some(profile.host.as_str()));
        assert_eq!(field("user"), Some(profile.user.as_str()));
        assert_eq!(field("port"), Some("2202"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn include_rejects_non_regular_files_and_proxy_jump_none_is_direct() {
        let root = temp_path("include-regular").parent().unwrap().to_path_buf();
        fs::create_dir_all(root.join("directory")).unwrap();
        fs::write(root.join("config"), "Host target\n  Include directory\n").unwrap();
        let invalid = resolve_config(
            &root.join("config"),
            &root,
            "local-user",
            &[],
            ResolverLimits::default(),
        );
        assert_eq!(invalid.diagnostics[0].code, "include_not_regular_file");
        fs::remove_dir_all(root).unwrap();

        let routed =
            parse_ssh_config("Host jump\n  ProxyJump none\nHost target\n  ProxyJump jump\n");
        let target = routed
            .imported
            .iter()
            .find(|profile| profile.label == "target")
            .unwrap();
        assert_eq!(target.proxy_jump_profile_id, "ssh-config-jump");
        assert_eq!(
            routed
                .imported
                .iter()
                .filter(|profile| profile.id == target.proxy_jump_profile_id)
                .count(),
            1
        );
    }

    #[test]
    fn proxy_jump_rejects_aliases_that_cannot_be_materialized() {
        for invalid_jump in [
            "Host jump\n  HostName bad/host\n",
            "Host jump\n  User bad/user\n",
            "Host jump\n  IdentityFile bad\u{1}path\n",
        ] {
            let result = parse_ssh_config(&format!(
                "{invalid_jump}Host target\n  HostName target.example\n  ProxyJump jump\n"
            ));
            assert!(!result
                .imported
                .iter()
                .any(|profile| profile.label == "target"));
            assert!(result.diagnostics.iter().any(|diagnostic| {
                diagnostic.alias == "target" && diagnostic.code == "proxy_jump_invalid_alias"
            }));
        }

        let expanded_none = parse_ssh_config("Host none\n  ProxyJump %n\n");
        assert!(expanded_none.imported.is_empty());
        assert_eq!(expanded_none.diagnostics[0].code, "proxy_jump_cycle");
    }

    #[test]
    fn saved_jump_ids_must_have_one_owner_across_namespaces() {
        let root = temp_path("jump-owner").parent().unwrap().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("config"),
            "Host other\n  HostName imported.example\nHost target\n  ProxyJump bastion\n",
        )
        .unwrap();
        let saved = SshHostProfile {
            id: "ssh-config-other".into(),
            label: "bastion".into(),
            host: "saved.example".into(),
            port: 22,
            user: "saved-user".into(),
            ..SshHostProfile::default()
        };
        let collision = resolve_config(
            &root.join("config"),
            &root,
            "local-user",
            std::slice::from_ref(&saved),
            ResolverLimits::default(),
        );
        assert!(!collision
            .imported
            .iter()
            .any(|profile| profile.label == "target"));
        assert!(collision.diagnostics.iter().any(|diagnostic| {
            diagnostic.alias == "target" && diagnostic.code == "proxy_jump_invalid_saved_profile"
        }));

        let mut self_collision = saved.clone();
        self_collision.id = "ssh-config-target".into();
        let self_reference = resolve_config(
            &root.join("config"),
            &root,
            "local-user",
            std::slice::from_ref(&self_collision),
            ResolverLimits::default(),
        );
        assert!(!self_reference
            .imported
            .iter()
            .any(|profile| profile.label == "target"));

        let mut duplicate = saved.clone();
        duplicate.label = "other-label".into();
        fs::write(root.join("config"), "Host target\n  ProxyJump bastion\n").unwrap();
        let duplicate_ids = resolve_config(
            &root.join("config"),
            &root,
            "local-user",
            &[saved, duplicate],
            ResolverLimits::default(),
        );
        assert!(duplicate_ids.imported.is_empty());
        assert_eq!(
            duplicate_ids.diagnostics[0].code,
            "proxy_jump_invalid_saved_profile"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
