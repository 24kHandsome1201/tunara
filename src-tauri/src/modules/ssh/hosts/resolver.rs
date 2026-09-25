use std::fs;
use std::path::{Path, PathBuf};

use super::patterns::{
    glob_match, is_resource_limit, CONFIG_MAX_BLOCKS, INCLUDE_MAX_BYTES, INCLUDE_MAX_DEPTH,
    INCLUDE_MAX_DIR_ENTRIES, INCLUDE_MAX_EXPANDED_PATHS, INCLUDE_MAX_FILES,
};

/// Tokenize one OpenSSH config line without treating quoted spaces or an
/// escaped `#` as separators/comments. Returns `None` for an unfinished quote
/// or escape so malformed input is skipped instead of partially imported.
pub(crate) fn ssh_config_tokens(line: &str) -> Option<Vec<String>> {
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

#[derive(Clone, Debug)]
pub(crate) struct LocatedDirective {
    pub(crate) source: String,
    pub(crate) line: usize,
    pub(crate) key: String,
    pub(crate) values: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum Selector {
    Global,
    Host(Vec<String>),
    Match(LocatedDirective),
}

#[derive(Clone, Debug)]
pub(crate) struct ConfigBlock {
    /// Selectors inherited at an Include call site.  The block selector is
    /// local to its file; this guard is what prevents included Host sections
    /// from escaping an inactive parent section.
    pub(crate) guards: Vec<Selector>,
    pub(crate) selector: Selector,
    pub(crate) directives: Vec<LocatedDirective>,
    pub(crate) hazards: Vec<(LocatedDirective, String)>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolverLimits {
    pub(crate) depth: usize,
    pub(crate) files: usize,
    pub(crate) bytes: usize,
    pub(crate) dir_entries: usize,
    pub(crate) expanded_paths: usize,
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

pub(crate) struct ConfigResolver<'a> {
    pub(crate) home: &'a Path,
    pub(crate) boundary: PathBuf,
    pub(crate) limits: ResolverLimits,
    pub(crate) files: usize,
    pub(crate) bytes: usize,
    pub(crate) dir_entries: usize,
    pub(crate) expanded_paths: usize,
    pub(crate) stack: Vec<PathBuf>,
    pub(crate) blocks: Vec<ConfigBlock>,
    pub(crate) exhausted: bool,
    // Only failures which cannot be associated with a parsed textual location.
    pub(crate) hazards: Vec<(LocatedDirective, String)>,
}

impl<'a> ConfigResolver<'a> {
    pub(crate) fn record_parse_hazard(
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

    pub(crate) fn new(
        root: &'a Path,
        home: &'a Path,
        limits: ResolverLimits,
    ) -> Result<Self, String> {
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

    pub(crate) fn push_block(&mut self, block: ConfigBlock, at: &LocatedDirective) -> bool {
        if self.blocks.len() >= CONFIG_MAX_BLOCKS {
            self.hazards.push((at.clone(), "config_block_limit".into()));
            self.exhausted = true;
            false
        } else {
            self.blocks.push(block);
            true
        }
    }

    pub(crate) fn expand_include_pattern(&mut self, value: &str) -> Result<Vec<PathBuf>, String> {
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

    pub(crate) fn parse_file(
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
