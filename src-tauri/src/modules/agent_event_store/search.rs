use super::*;
use std::collections::VecDeque;
use std::io::BufWriter;
use std::time::{Duration, Instant};

pub(super) const SEARCH_SCHEMA_VERSION: u16 = 1;
const SEARCH_DIR: &str = "search-v1";
const SEARCH_MANIFEST_FILE: &str = "manifest.json";
const SEARCH_DOCUMENTS_FILE: &str = "documents.jsonl";
const MAX_SEARCH_INDEX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SEARCH_DOCUMENT_BYTES: usize = MAX_PAYLOAD_BYTES * 6 + MAX_HEADER_BYTES + 4096;
const DEFAULT_SEARCH_PAGE_SIZE: usize = 50;
const MAX_SEARCH_PAGE_SIZE: usize = 100;
const MAX_SEARCH_QUERY_CHARS: usize = 128;
const MAX_SEARCH_TOKEN_CHARS: usize = 64;
const MAX_SEARCH_TOKENS: usize = 8;
const MAX_SEARCH_SNIPPET_CHARS: usize = 240;
const MAX_SEARCH_HIGHLIGHTS: usize = 8;
const SEARCH_TIME_BUDGET: Duration = Duration::from_millis(75);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchManifestV1 {
    schema_version: u16,
    delete_generation: u64,
    index_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchDocumentV1 {
    schema_version: u16,
    sequence: u64,
    event_id: String,
    workspace_id: String,
    task_id: String,
    kind: AgentEventKind,
    source: AgentEventSource,
    occurred_at_ms: i64,
    summary: String,
    payload_content_type: Option<String>,
    payload_byte_length: Option<u64>,
    payload_sha256: Option<String>,
    payload_text: Option<String>,
    image_metadata: Option<String>,
}

#[derive(Debug)]
pub(super) struct SearchIndexReady {
    root: PathBuf,
    manifest: SearchManifestV1,
    document_count: usize,
    index_bytes: u64,
}

#[derive(Debug)]
pub(super) enum SearchIndexMode {
    Ready(SearchIndexReady),
    Missing,
    Corrupt(&'static str),
    MigrationRequired(&'static str),
    QuotaExceeded(&'static str),
    Unavailable(&'static str),
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventSearchCapabilityState {
    Ready,
    Disabled,
    Missing,
    Corrupt,
    MigrationRequired,
    QuotaExceeded,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchStatus {
    pub capability: AgentEventSearchCapabilityState,
    pub schema_version: u16,
    pub document_count: Option<usize>,
    pub index_bytes: Option<u64>,
    pub max_index_bytes: u64,
    pub error_code: Option<String>,
    pub payload_text_is_private: bool,
    pub workspace_files_scanned: bool,
    pub image_ocr: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchFilters {
    #[serde(default)]
    pub kinds: Vec<AgentEventKind>,
    #[serde(default)]
    pub sources: Vec<AgentEventSource>,
    pub occurred_after_ms: Option<i64>,
    pub occurred_before_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchRequest {
    pub query: String,
    pub scope: AgentEventQueryScope,
    #[serde(default)]
    pub filters: AgentEventSearchFilters,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCursorV1 {
    version: u8,
    delete_generation: u64,
    index_generation: u64,
    snapshot_upper_bound: u64,
    before_sequence: u64,
    query_hash: String,
    scope: AgentEventQueryScope,
    filters: AgentEventSearchFilters,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchHighlight {
    pub start_char: usize,
    pub end_char: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventSearchMatchField {
    Summary,
    Payload,
    ImageMetadata,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchHit {
    pub header: AgentEventHeaderV1,
    pub match_summary: String,
    pub match_field: AgentEventSearchMatchField,
    pub highlights: Vec<AgentEventSearchHighlight>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchPage {
    pub items: Vec<AgentEventSearchHit>,
    pub next_cursor: Option<String>,
    pub snapshot_upper_bound: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventSearchRebuildResult {
    pub document_count: usize,
    pub index_bytes: u64,
    pub index_generation: u64,
}

fn search_root(store_root: &Path) -> PathBuf {
    store_root.join(SEARCH_DIR)
}

fn search_manifest_path(root: &Path) -> PathBuf {
    root.join(SEARCH_MANIFEST_FILE)
}

fn search_documents_path(root: &Path) -> PathBuf {
    root.join(SEARCH_DOCUMENTS_FILE)
}

fn write_search_manifest(root: &Path, manifest: &SearchManifestV1) -> StoreResult<()> {
    atomic_write(&search_manifest_path(root), &serialize_json(manifest)?)
}

fn create_empty_index(store_root: &Path, delete_generation: u64) -> StoreResult<SearchIndexReady> {
    let root = search_root(store_root);
    ensure_directory(&root)?;
    let manifest = SearchManifestV1 {
        schema_version: SEARCH_SCHEMA_VERSION,
        delete_generation,
        index_generation: 1,
    };
    write_search_manifest(&root, &manifest)?;
    atomic_write(&search_documents_path(&root), b"")?;
    Ok(SearchIndexReady {
        root,
        manifest,
        document_count: 0,
        index_bytes: 0,
    })
}

fn read_search_manifest(root: &Path) -> StoreResult<SearchManifestV1> {
    let path = search_manifest_path(root);
    if is_symlink(&path)? {
        return Err(StoreFault::new("searchUnsafeSymlink"));
    }
    let raw = fs::read(path).map_err(|_| StoreFault::new("searchManifestReadFailed"))?;
    let manifest: SearchManifestV1 =
        serde_json::from_slice(&raw).map_err(|_| StoreFault::new("searchManifestCorrupt"))?;
    if manifest.schema_version != SEARCH_SCHEMA_VERSION {
        return Err(StoreFault::new("searchMigrationRequired"));
    }
    if manifest.index_generation == 0 {
        return Err(StoreFault::new("searchManifestCorrupt"));
    }
    Ok(manifest)
}

fn document_matches_header(document: &SearchDocumentV1, header: &AgentEventHeaderV1) -> bool {
    document.schema_version == SEARCH_SCHEMA_VERSION
        && document.sequence == header.sequence
        && document.event_id == header.event_id
        && document.workspace_id == header.workspace_id
        && document.task_id == header.task_id
        && document.kind == header.kind
        && document.source == header.source
        && document.occurred_at_ms == header.occurred_at_ms
        && document.summary == header.summary
        && document.payload_content_type
            == header
                .payload
                .as_ref()
                .map(|payload| payload.content_type.clone())
        && document.payload_byte_length
            == header.payload.as_ref().map(|payload| payload.byte_length)
        && document.payload_sha256
            == header
                .payload
                .as_ref()
                .map(|payload| payload.sha256.clone())
        && match header
            .payload
            .as_ref()
            .map(|payload| payload.content_type.as_str())
        {
            Some("image/png" | "image/jpeg" | "image/webp") => {
                document.payload_text.is_none() && document.image_metadata.is_some()
            }
            Some("text/plain" | "text/markdown" | "application/json" | "text/x-diff") => {
                document.payload_text.is_some() && document.image_metadata.is_none()
            }
            None => document.payload_text.is_none() && document.image_metadata.is_none(),
            Some(_) => false,
        }
}

fn read_document_line(line: &[u8]) -> StoreResult<SearchDocumentV1> {
    if line.is_empty() || line.len() > MAX_SEARCH_DOCUMENT_BYTES {
        return Err(StoreFault::new("searchDocumentCorrupt"));
    }
    serde_json::from_slice(line).map_err(|_| StoreFault::new("searchDocumentCorrupt"))
}

fn validate_index(
    root: &Path,
    manifest: &SearchManifestV1,
    headers: &[AgentEventHeaderV1],
    delete_generation: u64,
) -> StoreResult<(usize, u64)> {
    if manifest.delete_generation != delete_generation {
        return Err(StoreFault::new("searchGenerationStale"));
    }
    let path = search_documents_path(root);
    if is_symlink(&path)? {
        return Err(StoreFault::new("searchUnsafeSymlink"));
    }
    let metadata = fs::metadata(&path).map_err(|_| StoreFault::new("searchDocumentsMissing"))?;
    if !metadata.is_file() || metadata.len() > MAX_SEARCH_INDEX_BYTES {
        return Err(StoreFault::new("searchQuotaExceeded"));
    }
    let file = File::open(path).map_err(|_| StoreFault::new("searchDocumentsReadFailed"))?;
    let reader = BufReader::new(file);
    let mut count = 0usize;
    for line in reader.split(b'\n') {
        let line = line.map_err(|_| StoreFault::new("searchDocumentsReadFailed"))?;
        if line.is_empty() {
            continue;
        }
        let document = read_document_line(&line)?;
        let header = headers
            .get(count)
            .ok_or_else(|| StoreFault::new("searchDocumentStale"))?;
        if !document_matches_header(&document, header) {
            return Err(StoreFault::new("searchDocumentStale"));
        }
        count += 1;
    }
    if count != headers.len() {
        return Err(StoreFault::new("searchDocumentStale"));
    }
    Ok((count, metadata.len()))
}

fn classify_search_fault(fault: StoreFault) -> SearchIndexMode {
    match fault.code {
        "searchMigrationRequired" => SearchIndexMode::MigrationRequired(fault.code),
        "searchManifestCorrupt" | "searchDocumentCorrupt" => SearchIndexMode::Corrupt(fault.code),
        "searchQuotaExceeded" => SearchIndexMode::QuotaExceeded(fault.code),
        "searchDocumentsMissing" | "searchDocumentStale" | "searchGenerationStale" => {
            SearchIndexMode::Missing
        }
        _ => SearchIndexMode::Unavailable(fault.code),
    }
}

pub(super) fn open_index(
    store_root: &Path,
    headers: &[AgentEventHeaderV1],
    delete_generation: u64,
) -> SearchIndexMode {
    let root = search_root(store_root);
    if !root.exists() {
        return if headers.is_empty() {
            create_empty_index(store_root, delete_generation)
                .map(SearchIndexMode::Ready)
                .unwrap_or_else(classify_search_fault)
        } else {
            SearchIndexMode::Missing
        };
    }
    if is_symlink(&root).unwrap_or(true) || !root.is_dir() {
        return SearchIndexMode::Unavailable("searchUnsafeSymlink");
    }
    let manifest = match read_search_manifest(&root) {
        Ok(manifest) => manifest,
        Err(fault) => return classify_search_fault(fault),
    };
    match validate_index(&root, &manifest, headers, delete_generation) {
        Ok((document_count, index_bytes)) => SearchIndexMode::Ready(SearchIndexReady {
            root,
            manifest,
            document_count,
            index_bytes,
        }),
        Err(fault) => classify_search_fault(fault),
    }
}

pub(super) fn status(mode: &SearchIndexMode) -> AgentEventSearchStatus {
    let (capability, document_count, index_bytes, error_code) = match mode {
        SearchIndexMode::Ready(index) => (
            AgentEventSearchCapabilityState::Ready,
            Some(index.document_count),
            Some(index.index_bytes),
            None,
        ),
        SearchIndexMode::Missing => (
            AgentEventSearchCapabilityState::Missing,
            None,
            None,
            Some("searchIndexMissing".to_string()),
        ),
        SearchIndexMode::Corrupt(code) => (
            AgentEventSearchCapabilityState::Corrupt,
            None,
            None,
            Some((*code).to_string()),
        ),
        SearchIndexMode::MigrationRequired(code) => (
            AgentEventSearchCapabilityState::MigrationRequired,
            None,
            None,
            Some((*code).to_string()),
        ),
        SearchIndexMode::QuotaExceeded(code) => (
            AgentEventSearchCapabilityState::QuotaExceeded,
            None,
            None,
            Some((*code).to_string()),
        ),
        SearchIndexMode::Unavailable(code) => (
            AgentEventSearchCapabilityState::Unavailable,
            None,
            None,
            Some((*code).to_string()),
        ),
    };
    AgentEventSearchStatus {
        capability,
        schema_version: SEARCH_SCHEMA_VERSION,
        document_count,
        index_bytes,
        max_index_bytes: MAX_SEARCH_INDEX_BYTES,
        error_code,
        payload_text_is_private: true,
        workspace_files_scanned: false,
        image_ocr: false,
    }
}

pub(super) fn disabled_status() -> AgentEventSearchStatus {
    AgentEventSearchStatus {
        capability: AgentEventSearchCapabilityState::Disabled,
        schema_version: SEARCH_SCHEMA_VERSION,
        document_count: None,
        index_bytes: None,
        max_index_bytes: MAX_SEARCH_INDEX_BYTES,
        error_code: None,
        payload_text_is_private: true,
        workspace_files_scanned: false,
        image_ocr: false,
    }
}

fn image_metadata(header: &AgentEventHeaderV1) -> Option<String> {
    let payload = header.payload.as_ref()?;
    if !matches!(
        payload.content_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return None;
    }
    Some(format!(
        "{} {} bytes sha256 {}",
        payload.content_type, payload.byte_length, payload.sha256
    ))
}

fn build_document(
    header: &AgentEventHeaderV1,
    payload: Option<&AgentEventPrivatePayloadInput>,
) -> StoreResult<SearchDocumentV1> {
    let payload_text = match header
        .payload
        .as_ref()
        .map(|meta| meta.content_type.as_str())
    {
        Some("text/plain" | "text/markdown" | "application/json" | "text/x-diff") => {
            let payload = payload.ok_or_else(|| StoreFault::new("searchPayloadMissing"))?;
            let meta = header.payload.as_ref().expect("checked payload metadata");
            if payload.content_type != meta.content_type
                || payload.body.len() as u64 != meta.byte_length
                || sha256_hex(payload.body.as_bytes()) != meta.sha256
            {
                return Err(StoreFault::new("searchPayloadCorrupt"));
            }
            Some(payload.body.clone())
        }
        _ => None,
    };
    Ok(SearchDocumentV1 {
        schema_version: SEARCH_SCHEMA_VERSION,
        sequence: header.sequence,
        event_id: header.event_id.clone(),
        workspace_id: header.workspace_id.clone(),
        task_id: header.task_id.clone(),
        kind: header.kind.clone(),
        source: header.source.clone(),
        occurred_at_ms: header.occurred_at_ms,
        summary: header.summary.clone(),
        payload_content_type: header
            .payload
            .as_ref()
            .map(|payload| payload.content_type.clone()),
        payload_byte_length: header.payload.as_ref().map(|payload| payload.byte_length),
        payload_sha256: header
            .payload
            .as_ref()
            .map(|payload| payload.sha256.clone()),
        payload_text,
        image_metadata: image_metadata(header),
    })
}

fn append_document_ready(
    index: &mut SearchIndexReady,
    document: &SearchDocumentV1,
) -> StoreResult<()> {
    let line = serialize_document_line(document)?;
    if index.index_bytes.saturating_add(line.len() as u64) > MAX_SEARCH_INDEX_BYTES {
        return Err(StoreFault::new("searchQuotaExceeded"));
    }
    let path = search_documents_path(&index.root);
    if is_symlink(&path)? {
        return Err(StoreFault::new("searchUnsafeSymlink"));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| StoreFault::new("searchAppendFailed"))?;
    file.write_all(&line)
        .map_err(|_| StoreFault::new("searchAppendFailed"))?;
    file.sync_all()
        .map_err(|_| StoreFault::new("searchSyncFailed"))?;
    index.document_count += 1;
    index.index_bytes += line.len() as u64;
    Ok(())
}

fn serialize_document_line(document: &SearchDocumentV1) -> StoreResult<Vec<u8>> {
    let mut line = serialize_json(document)?;
    if line.len() > MAX_SEARCH_DOCUMENT_BYTES {
        return Err(StoreFault::new("searchDocumentTooLarge"));
    }
    line.push(b'\n');
    Ok(line)
}

pub(super) fn append_document(
    mode: &mut SearchIndexMode,
    header: &AgentEventHeaderV1,
    payload: Option<&AgentEventPrivatePayloadInput>,
) {
    let SearchIndexMode::Ready(index) = mode else {
        return;
    };
    let result = build_document(header, payload)
        .and_then(|document| append_document_ready(index, &document));
    if let Err(fault) = result {
        *mode = classify_search_fault(fault);
    }
}

fn validate_filters(filters: &AgentEventSearchFilters) -> StoreResult<()> {
    if filters.kinds.len() > 9 || filters.sources.len() > 6 {
        return Err(StoreFault::new("invalidSearchFilters"));
    }
    if filters
        .occurred_after_ms
        .zip(filters.occurred_before_ms)
        .is_some_and(|(after, before)| after > before)
    {
        return Err(StoreFault::new("invalidSearchFilters"));
    }
    Ok(())
}

fn normalize_query(query: &str) -> StoreResult<(String, Vec<Vec<char>>)> {
    if query.chars().any(char::is_control) {
        return Err(StoreFault::new("invalidSearchQuery"));
    }
    let char_count = query.chars().count();
    if !(2..=MAX_SEARCH_QUERY_CHARS).contains(&char_count) {
        return Err(StoreFault::new("invalidSearchQuery"));
    }
    let normalized = query
        .split_whitespace()
        .map(|part| {
            part.chars()
                .flat_map(char::to_lowercase)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(" ");
    let raw_tokens: Vec<&str> = normalized
        .split(' ')
        .filter(|token| !token.is_empty())
        .collect();
    if raw_tokens.is_empty() || raw_tokens.len() > MAX_SEARCH_TOKENS {
        return Err(StoreFault::new("invalidSearchQuery"));
    }
    let mut tokens = Vec::with_capacity(raw_tokens.len());
    for token in raw_tokens {
        let chars: Vec<char> = token.chars().collect();
        if chars.is_empty() || chars.len() > MAX_SEARCH_TOKEN_CHARS {
            return Err(StoreFault::new("invalidSearchQuery"));
        }
        tokens.push(chars);
    }
    Ok((normalized, tokens))
}

fn normalize_with_map(value: &str) -> (Vec<char>, Vec<usize>, Vec<char>) {
    let original: Vec<char> = value.chars().collect();
    let mut normalized = Vec::new();
    let mut original_index = Vec::new();
    let mut previous_space = false;
    for (index, character) in original.iter().copied().enumerate() {
        if character.is_whitespace() {
            if !previous_space {
                normalized.push(' ');
                original_index.push(index);
            }
            previous_space = true;
            continue;
        }
        previous_space = false;
        for lowered in character.to_lowercase() {
            normalized.push(lowered);
            original_index.push(index);
        }
    }
    (normalized, original_index, original)
}

fn find_token(haystack: &[char], token: &[char]) -> Option<usize> {
    if token.is_empty() || token.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(token.len())
        .position(|window| window == token)
}

fn field_contains_all(value: &str, tokens: &[Vec<char>]) -> bool {
    let (normalized, _, _) = normalize_with_map(value);
    tokens
        .iter()
        .all(|token| find_token(&normalized, token).is_some())
}

fn document_matches_tokens(document: &SearchDocumentV1, tokens: &[Vec<char>]) -> bool {
    let combined = [
        Some(document.summary.as_str()),
        document.payload_text.as_deref(),
        document.image_metadata.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    field_contains_all(&combined, tokens)
}

fn select_match_field<'a>(
    document: &'a SearchDocumentV1,
    tokens: &[Vec<char>],
) -> (AgentEventSearchMatchField, &'a str) {
    if field_contains_all(&document.summary, tokens) {
        return (AgentEventSearchMatchField::Summary, &document.summary);
    }
    if let Some(payload) = document
        .payload_text
        .as_deref()
        .filter(|payload| field_contains_all(payload, tokens))
    {
        return (AgentEventSearchMatchField::Payload, payload);
    }
    if let Some(metadata) = document.image_metadata.as_deref() {
        return (AgentEventSearchMatchField::ImageMetadata, metadata);
    }
    if let Some(payload) = document.payload_text.as_deref() {
        (AgentEventSearchMatchField::Payload, payload)
    } else {
        (AgentEventSearchMatchField::Summary, &document.summary)
    }
}

fn make_snippet(value: &str, tokens: &[Vec<char>]) -> (String, Vec<AgentEventSearchHighlight>) {
    let (normalized, map, original) = normalize_with_map(value);
    let first = tokens
        .iter()
        .filter_map(|token| find_token(&normalized, token).map(|start| (start, token.len())))
        .min_by_key(|(start, _)| *start);
    let first_original = first
        .and_then(|(start, _)| map.get(start).copied())
        .unwrap_or(0);
    let snippet_start = first_original.saturating_sub(72);
    let snippet_end = original.len().min(snippet_start + MAX_SEARCH_SNIPPET_CHARS);
    let snippet: String = original[snippet_start..snippet_end].iter().collect();
    let mut highlights = Vec::new();
    for token in tokens {
        let mut offset = 0usize;
        while offset + token.len() <= normalized.len() && highlights.len() < MAX_SEARCH_HIGHLIGHTS {
            let Some(relative) = find_token(&normalized[offset..], token) else {
                break;
            };
            let normalized_start = offset + relative;
            let normalized_end = normalized_start + token.len() - 1;
            let Some(original_start) = map.get(normalized_start).copied() else {
                break;
            };
            let Some(original_end) = map.get(normalized_end).copied().map(|index| index + 1) else {
                break;
            };
            if original_start >= snippet_start
                && original_end <= snippet_end
                && original_start < original_end
            {
                highlights.push(AgentEventSearchHighlight {
                    start_char: original_start - snippet_start,
                    end_char: original_end - snippet_start,
                });
            }
            offset = normalized_start + token.len();
        }
    }
    highlights.sort_by_key(|highlight| (highlight.start_char, highlight.end_char));
    highlights.dedup_by_key(|highlight| (highlight.start_char, highlight.end_char));
    (snippet, highlights)
}

fn document_matches_filters(
    document: &SearchDocumentV1,
    filters: &AgentEventSearchFilters,
) -> bool {
    (filters.kinds.is_empty() || filters.kinds.contains(&document.kind))
        && (filters.sources.is_empty() || filters.sources.contains(&document.source))
        && filters
            .occurred_after_ms
            .is_none_or(|after| document.occurred_at_ms >= after)
        && filters
            .occurred_before_ms
            .is_none_or(|before| document.occurred_at_ms <= before)
}

fn document_matches_scope(document: &SearchDocumentV1, scope: &AgentEventQueryScope) -> bool {
    match scope {
        AgentEventQueryScope::All => true,
        AgentEventQueryScope::Workspace { workspace_id } => document.workspace_id == *workspace_id,
        AgentEventQueryScope::Task {
            workspace_id,
            task_id,
        } => document.workspace_id == *workspace_id && document.task_id == *task_id,
    }
}

impl AgentEventStore {
    pub(super) fn search(
        &self,
        request: AgentEventSearchRequest,
    ) -> StoreResult<AgentEventSearchPage> {
        validate_query_scope(&request.scope)?;
        validate_filters(&request.filters)?;
        let (normalized_query, tokens) = normalize_query(&request.query)?;
        let limit = request.limit.unwrap_or(DEFAULT_SEARCH_PAGE_SIZE);
        if limit == 0 || limit > MAX_SEARCH_PAGE_SIZE {
            return Err(StoreFault::new("invalidSearchPageSize"));
        }
        let SearchIndexMode::Ready(index) = &self.search_index else {
            return Err(StoreFault::new("searchUnavailable"));
        };
        let query_hash = sha256_hex(normalized_query.as_bytes());
        let (snapshot_upper_bound, before_sequence) = if let Some(cursor) = request.cursor {
            let decoded = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| StoreFault::new("invalidSearchCursor"))?;
            let cursor: SearchCursorV1 = serde_json::from_slice(&decoded)
                .map_err(|_| StoreFault::new("invalidSearchCursor"))?;
            if cursor.version != 1
                || cursor.delete_generation != self.manifest.delete_generation
                || cursor.index_generation != index.manifest.index_generation
                || cursor.scope != request.scope
                || cursor.filters != request.filters
                || cursor.query_hash != query_hash
                || cursor.before_sequence > cursor.snapshot_upper_bound.saturating_add(1)
            {
                return Err(StoreFault::new("invalidSearchCursor"));
            }
            (cursor.snapshot_upper_bound, cursor.before_sequence)
        } else {
            let snapshot = self.headers.last().map_or(0, |header| header.sequence);
            (snapshot, snapshot.saturating_add(1))
        };

        let path = search_documents_path(&index.root);
        if is_symlink(&path)? {
            return Err(StoreFault::new("searchUnsafeSymlink"));
        }
        let file = File::open(path).map_err(|_| StoreFault::new("searchDocumentsReadFailed"))?;
        let reader = BufReader::new(file);
        let started = Instant::now();
        let mut matches = VecDeque::with_capacity(limit + 1);
        let mut has_more = false;
        for line in reader.split(b'\n') {
            if started.elapsed() > SEARCH_TIME_BUDGET {
                return Err(StoreFault::new("searchTimeout"));
            }
            let line = line.map_err(|_| StoreFault::new("searchDocumentsReadFailed"))?;
            if line.is_empty() {
                continue;
            }
            let document = read_document_line(&line)?;
            if document.sequence > snapshot_upper_bound
                || document.sequence >= before_sequence
                || !document_matches_scope(&document, &request.scope)
                || !document_matches_filters(&document, &request.filters)
                || !document_matches_tokens(&document, &tokens)
            {
                continue;
            }
            let header = self
                .headers
                .binary_search_by_key(&document.sequence, |header| header.sequence)
                .ok()
                .and_then(|index| self.headers.get(index))
                .ok_or_else(|| StoreFault::new("searchDocumentStale"))?
                .clone();
            let (match_field, field) = select_match_field(&document, &tokens);
            let (match_summary, highlights) = make_snippet(field, &tokens);
            matches.push_back(AgentEventSearchHit {
                header,
                match_summary,
                match_field,
                highlights,
            });
            if matches.len() > limit {
                matches.pop_front();
                has_more = true;
            }
        }
        let mut items: Vec<_> = matches.into_iter().collect();
        items.reverse();
        let next_cursor = if has_more {
            items.last().and_then(|last| {
                let cursor = SearchCursorV1 {
                    version: 1,
                    delete_generation: self.manifest.delete_generation,
                    index_generation: index.manifest.index_generation,
                    snapshot_upper_bound,
                    before_sequence: last.header.sequence,
                    query_hash,
                    scope: request.scope,
                    filters: request.filters,
                };
                serialize_json(&cursor)
                    .ok()
                    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            })
        } else {
            None
        };
        Ok(AgentEventSearchPage {
            items,
            next_cursor,
            snapshot_upper_bound,
        })
    }

    pub(super) fn rebuild_search_index(
        &mut self,
        confirmed: bool,
    ) -> StoreResult<AgentEventSearchRebuildResult> {
        if !confirmed {
            return Err(StoreFault::new("confirmationRequired"));
        }
        let old_generation = match &self.search_index {
            SearchIndexMode::Ready(index) => index.manifest.index_generation,
            _ => 0,
        };
        let index_generation = old_generation.saturating_add(1).max(now_ms().max(1) as u64);
        let target = search_root(&self.root);
        let temporary = self
            .root
            .join(format!(".{SEARCH_DIR}.rebuild-{index_generation}"));
        if temporary.exists() {
            remove_store_root(&temporary)?;
        }
        ensure_directory(&temporary)?;
        let manifest = SearchManifestV1 {
            schema_version: SEARCH_SCHEMA_VERSION,
            delete_generation: self.manifest.delete_generation,
            index_generation,
        };
        write_search_manifest(&temporary, &manifest)?;
        let mut building = SearchIndexReady {
            root: temporary.clone(),
            manifest: manifest.clone(),
            document_count: 0,
            index_bytes: 0,
        };
        let build_result = (|| -> StoreResult<()> {
            let documents_path = search_documents_path(&temporary);
            let file = secure_write_new(&documents_path, b"")?;
            let mut writer = BufWriter::new(file);
            let headers = self.headers.clone();
            for header in &headers {
                let payload = match header
                    .payload
                    .as_ref()
                    .map(|meta| meta.content_type.as_str())
                {
                    Some("text/plain" | "text/markdown" | "application/json" | "text/x-diff") => {
                        let loaded = self.payload(&header.event_id)?;
                        Some(AgentEventPrivatePayloadInput {
                            content_type: loaded.content_type,
                            body: loaded.body,
                        })
                    }
                    _ => None,
                };
                let document = build_document(header, payload.as_ref())?;
                let line = serialize_document_line(&document)?;
                if building.index_bytes.saturating_add(line.len() as u64) > MAX_SEARCH_INDEX_BYTES {
                    return Err(StoreFault::new("searchQuotaExceeded"));
                }
                writer
                    .write_all(&line)
                    .map_err(|_| StoreFault::new("searchAppendFailed"))?;
                building.document_count += 1;
                building.index_bytes += line.len() as u64;
            }
            writer
                .flush()
                .map_err(|_| StoreFault::new("searchSyncFailed"))?;
            let file = writer
                .into_inner()
                .map_err(|_| StoreFault::new("searchSyncFailed"))?;
            file.sync_all()
                .map_err(|_| StoreFault::new("searchSyncFailed"))?;
            Ok(())
        })();
        if let Err(fault) = build_result {
            let _ = remove_store_root(&temporary);
            return Err(fault);
        }

        let backup = self
            .root
            .join(format!(".{SEARCH_DIR}.backup-{index_generation}"));
        if backup.exists() {
            remove_store_root(&backup)?;
        }
        if target.exists() {
            fs::rename(&target, &backup).map_err(|_| StoreFault::new("searchReplaceFailed"))?;
        }
        if fs::rename(&temporary, &target).is_err() {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(StoreFault::new("searchReplaceFailed"));
        }
        if backup.exists() {
            remove_store_root(&backup)?;
        }
        building.root = target;
        let result = AgentEventSearchRebuildResult {
            document_count: building.document_count,
            index_bytes: building.index_bytes,
            index_generation,
        };
        self.search_index = SearchIndexMode::Ready(building);
        Ok(result)
    }
}

pub(super) fn apply_delete(
    mode: &mut SearchIndexMode,
    store_root: &Path,
    remaining_headers: &[AgentEventHeaderV1],
    next_delete_generation: u64,
) -> StoreResult<()> {
    let root = search_root(store_root);
    let SearchIndexMode::Ready(index) = mode else {
        if root.exists() {
            remove_store_root(&root)?;
        }
        *mode = SearchIndexMode::Missing;
        return Ok(());
    };
    let remaining: HashSet<u64> = remaining_headers
        .iter()
        .map(|header| header.sequence)
        .collect();
    let path = search_documents_path(&index.root);
    let file = File::open(&path).map_err(|_| StoreFault::new("searchDocumentsReadFailed"))?;
    let reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut count = 0usize;
    for line in reader.split(b'\n') {
        let line = line.map_err(|_| StoreFault::new("searchDocumentsReadFailed"))?;
        if line.is_empty() {
            continue;
        }
        let document = read_document_line(&line)?;
        if remaining.contains(&document.sequence) {
            bytes.extend_from_slice(&line);
            bytes.push(b'\n');
            count += 1;
        }
    }
    atomic_write(&path, &bytes)?;
    index.manifest.delete_generation = next_delete_generation;
    index.manifest.index_generation = index.manifest.index_generation.saturating_add(1);
    write_search_manifest(&index.root, &index.manifest)?;
    index.document_count = count;
    index.index_bytes = bytes.len() as u64;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_snippets_have_scalar_safe_highlights() {
        let tokens = normalize_query("中文 parse::item").unwrap().1;
        let text = "前置 中文 内容，再调用 parse::Item() 完成";
        let (snippet, highlights) = make_snippet(text, &tokens);
        let chars: Vec<char> = snippet.chars().collect();
        assert_eq!(highlights.len(), 2);
        for highlight in highlights {
            assert!(highlight.start_char < highlight.end_char);
            assert!(highlight.end_char <= chars.len());
        }
    }

    #[test]
    fn query_contract_rejects_empty_control_and_complex_input() {
        assert!(normalize_query("").is_err());
        assert!(normalize_query("a").is_err());
        assert!(normalize_query("ok\nno").is_err());
        assert!(normalize_query("a b c d e f g h i").is_err());
        assert!(normalize_query("中文").is_ok());
        assert!(normalize_query("src/foo.rs parse::Item").is_ok());
    }
}
