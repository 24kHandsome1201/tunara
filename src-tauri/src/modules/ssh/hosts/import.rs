use std::cell::Cell;
#[cfg(test)]
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::effective::{
    canonical_settings, canonicalize_for_second_pass, expand_hostname, expand_value,
    local_account_name, match_selector, requests_final_pass, valid_resolved_host,
    valid_resolved_user, CanonicalLookup, EffectiveConfig, MatchPhase, INITIAL_MATCH_PHASE,
};
use super::patterns::{
    is_resource_limit, pattern_list_matches, PatternBudget, CONFIG_MAX_ALIASES,
    CONFIG_MAX_SELECTOR_EVALUATIONS,
};
use super::profile::{hosts_path, read_hosts, SshHostProfile};
use super::resolver::{ConfigResolver, LocatedDirective, ResolverLimits, Selector};
use crate::modules::ssh::auth::AuthMethod;

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

pub(crate) fn diagnostic(
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

pub(crate) fn literal_jump_profile(value: &str) -> Option<SshHostProfile> {
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
        ..SshHostProfile::default()
    })
}

pub(crate) fn resolve_config_with_lookup(
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
            ..SshHostProfile::default()
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
    if status != 0 {
        return Ok(None);
    }
    let Some(info) = (unsafe { result.as_ref() }) else {
        return Ok(None);
    };
    let canonical_name = unsafe {
        let value = info.ai_canonname;
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

pub(crate) fn resolve_config(
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
