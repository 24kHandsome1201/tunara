use std::cell::Cell;

pub(crate) const INCLUDE_MAX_DEPTH: usize = 8;

pub(crate) const INCLUDE_MAX_FILES: usize = 64;

pub(crate) const INCLUDE_MAX_BYTES: usize = 1024 * 1024;

pub(crate) const INCLUDE_MAX_DIR_ENTRIES: usize = 4096;

pub(crate) const INCLUDE_MAX_EXPANDED_PATHS: usize = 1024;

pub(crate) const CONFIG_MAX_BLOCKS: usize = 4096;

pub(crate) const CONFIG_MAX_ALIASES: usize = 2048;

pub(crate) const CONFIG_MAX_SELECTOR_EVALUATIONS: usize = 20_000;

pub(crate) const PATTERN_MAX_OPERATIONS: usize = 4_096;

pub(crate) const CANONICAL_MAX_LOOKUPS: usize = 64;

pub(crate) struct PatternBudget {
    operations: Cell<usize>,
}

impl PatternBudget {
    pub(crate) fn new() -> Self {
        Self {
            operations: Cell::new(0),
        }
    }

    pub(crate) fn charge(&self) -> Result<(), String> {
        let operations = self.operations.get().saturating_add(1);
        self.operations.set(operations);
        if operations > PATTERN_MAX_OPERATIONS {
            Err("pattern_operation_limit".into())
        } else {
            Ok(())
        }
    }
}

pub(crate) fn is_resource_limit(code: &str) -> bool {
    code.ends_with("_limit")
}

pub(crate) fn glob_match(pattern: &str, value: &str) -> Result<bool, String> {
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
pub(crate) fn ssh_pattern_match(
    pattern: &str,
    value: &str,
    case_sensitive: bool,
) -> Result<bool, String> {
    ssh_pattern_match_with_budget(pattern, value, case_sensitive, &PatternBudget::new())
}

pub(crate) fn ssh_pattern_match_with_budget(
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

pub(crate) fn pattern_list_matches(
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
