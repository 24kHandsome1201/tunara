use std::cell::Cell;
use std::path::Path;

use super::patterns::{pattern_list_matches, PatternBudget, CANONICAL_MAX_LOOKUPS};
use super::resolver::{ConfigBlock, LocatedDirective, Selector};

#[derive(Default)]
pub(crate) struct EffectiveConfig {
    pub(crate) host_name: Option<(String, LocatedDirective)>,
    pub(crate) user: Option<(String, LocatedDirective)>,
    pub(crate) port: Option<(String, LocatedDirective)>,
    pub(crate) proxy_jump: Option<(String, LocatedDirective)>,
    pub(crate) identities: Vec<(String, LocatedDirective)>,
    pub(crate) certificates: Vec<(String, LocatedDirective)>,
    pub(crate) canonicalize_hostname: Option<(String, LocatedDirective)>,
    pub(crate) canonical_domains: Option<(Vec<String>, LocatedDirective)>,
    pub(crate) canonicalize_max_dots: Option<(String, LocatedDirective)>,
    pub(crate) canonicalize_fallback_local: Option<(String, LocatedDirective)>,
    pub(crate) canonicalize_permitted_cnames: Option<(Vec<String>, LocatedDirective)>,
    pub(crate) additive_applied: std::collections::BTreeSet<(String, usize, String)>,
    pub(crate) rejection: Option<(LocatedDirective, String)>,
}

#[derive(Clone, Copy)]
pub(crate) struct MatchPhase {
    pub(crate) canonical: bool,
    pub(crate) final_pass: bool,
}

pub(crate) const INITIAL_MATCH_PHASE: MatchPhase = MatchPhase {
    canonical: false,
    final_pass: false,
};

pub(crate) struct CanonicalLookup {
    pub(crate) canonical_name: Option<String>,
}

pub(crate) fn valid_resolved_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1_024
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'))
}

pub(crate) fn valid_resolved_user(value: &str) -> bool {
    value.len() <= 256
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '@' | '\\'))
}

pub(crate) fn match_selector(
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

pub(crate) fn expand_value(
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

pub(crate) fn expand_hostname(value: &str, alias: &str) -> Result<String, String> {
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
pub(crate) fn local_account_name() -> Option<String> {
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

pub(crate) fn requests_final_pass(blocks: &[ConfigBlock]) -> bool {
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

pub(crate) struct CnameRule {
    source: Vec<String>,
    target: Vec<String>,
}

pub(crate) struct CanonicalSettings {
    mode: String,
    mode_directive: Option<LocatedDirective>,
    domains: Vec<String>,
    domains_directive: Option<LocatedDirective>,
    max_dots: u8,
    fallback: bool,
    cname_rules: Option<Vec<CnameRule>>,
    cname_directive: Option<LocatedDirective>,
}

pub(crate) fn canonical_settings(
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

pub(crate) fn canonicalize_for_second_pass(
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
