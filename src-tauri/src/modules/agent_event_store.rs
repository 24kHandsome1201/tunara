use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const SCHEMA_VERSION: u16 = 1;
const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_PAGE_SIZE: usize = 200;
const MAX_EVENT_COUNT: usize = 100_000;
const MAX_PAYLOAD_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_SUMMARY_BYTES: usize = 512;
const MAX_ID_BYTES: usize = 256;
const MAX_CONTENT_TYPE_BYTES: usize = 128;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

const MANIFEST_FILE: &str = "manifest.json";
const HEADERS_FILE: &str = "headers.jsonl";
const PAYLOADS_DIR: &str = "payloads";
const DELETE_PENDING_FILE: &str = "delete.pending.json";
const DISABLED_FILE: &str = "disabled";
const APPENDED_EVENT: &str = "agent-event://appended";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventKind {
    UserInput,
    AgentStatus,
    OutputSummary,
    ToolCall,
    FileChange,
    TestResult,
    ConfirmationRequest,
    PreviewEvidence,
    JournalReference,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentEventSource {
    Hook,
    Process,
    ShellIntegration,
    Heuristic,
    User,
    System,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayloadMetaV1 {
    pub state: AgentEventPayloadState,
    pub content_type: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventPayloadState {
    Available,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventHeaderV1 {
    pub schema_version: u16,
    pub sequence: u64,
    pub event_id: String,
    pub client_event_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub session_id: Option<String>,
    pub kind: AgentEventKind,
    pub source: AgentEventSource,
    pub occurred_at_ms: i64,
    pub recorded_at_ms: i64,
    pub summary: String,
    pub payload: Option<AgentEventPayloadMetaV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPrivatePayloadInput {
    pub content_type: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventAppendRequest {
    pub client_event_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub session_id: Option<String>,
    pub kind: AgentEventKind,
    pub source: AgentEventSource,
    pub occurred_at_ms: Option<i64>,
    pub summary: String,
    pub private_payload: Option<AgentEventPrivatePayloadInput>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventAppendStatus {
    Appended,
    Duplicate,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventAppendResult {
    pub status: AgentEventAppendStatus,
    pub header: AgentEventHeaderV1,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEventQueryScope {
    All,
    Workspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    Task {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventListRequest {
    pub scope: AgentEventQueryScope,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPage {
    pub items: Vec<AgentEventHeaderV1>,
    pub next_cursor: Option<String>,
    pub snapshot_upper_bound: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPayload {
    pub event_id: String,
    pub content_type: String,
    pub body: String,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEventDeleteScope {
    All,
    Workspace {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    },
    Task {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventDeleteRequest {
    pub scope: AgentEventDeleteScope,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventDeleteResult {
    pub deleted_headers: u64,
    pub deleted_payloads: u64,
    pub freed_payload_bytes: u64,
    pub counts_accurate: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventStoreCapabilityState {
    Enabled,
    Disabled,
    Corrupt,
    MigrationRequired,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventRetentionPolicy {
    pub max_events: usize,
    pub max_payload_bytes: u64,
    pub auto_prune: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventExportPolicy {
    pub supported: bool,
    pub background_export: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventPrivacyPolicy {
    pub header_contains_private_body: bool,
    pub payload_requires_explicit_read: bool,
    pub telemetry_upload: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventStoreStatus {
    pub capability: AgentEventStoreCapabilityState,
    pub schema_version: u16,
    pub data_location: String,
    pub event_count: Option<usize>,
    pub payload_bytes: Option<u64>,
    pub recovered_partial_tail: bool,
    pub error_code: Option<String>,
    pub retention: AgentEventRetentionPolicy,
    pub export: AgentEventExportPolicy,
    pub privacy: AgentEventPrivacyPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestV1 {
    schema_version: u16,
    delete_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredPayloadV1 {
    schema_version: u16,
    event_id: String,
    content_type: String,
    body: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CursorV1 {
    version: u8,
    delete_generation: u64,
    snapshot_upper_bound: u64,
    before_sequence: u64,
    scope: AgentEventQueryScope,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDeleteEvent {
    sequence: u64,
    had_payload: bool,
    payload_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDeleteV1 {
    schema_version: u16,
    next_generation: u64,
    events: Vec<PendingDeleteEvent>,
}

#[derive(Debug)]
struct StoreFault {
    code: &'static str,
}

impl StoreFault {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

type StoreResult<T> = Result<T, StoreFault>;

#[derive(Debug)]
struct AgentEventStore {
    root: PathBuf,
    manifest: ManifestV1,
    headers: Vec<AgentEventHeaderV1>,
    client_index: HashMap<(String, String), usize>,
    payload_bytes: u64,
    recovered_partial_tail: bool,
    #[cfg(test)]
    payload_reads: u64,
}

#[derive(Debug)]
enum StoreMode {
    Ready(AgentEventStore),
    Disabled,
    Corrupt(&'static str),
    MigrationRequired(&'static str),
    Unavailable(&'static str),
}

#[derive(Debug)]
struct AgentEventStoreInner {
    base_dir: PathBuf,
    root: PathBuf,
    disabled_marker: PathBuf,
    mode: StoreMode,
}

#[derive(Clone, Debug)]
pub struct AgentEventStoreState {
    inner: Arc<Mutex<AgentEventStoreInner>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn event_id(sequence: u64) -> String {
    format!("ae-{sequence:020}")
}

fn validate_identifier(value: &str, max_bytes: usize, allow_slash: bool) -> StoreResult<()> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.trim() != value
        || value == "."
        || value == ".."
        || value.chars().any(char::is_control)
        || (!allow_slash && (value.contains('/') || value.contains('\\')))
    {
        return Err(StoreFault::new("invalidField"));
    }
    Ok(())
}

fn validate_summary(value: &str) -> StoreResult<()> {
    if value.len() > MAX_SUMMARY_BYTES || value.chars().any(char::is_control) {
        return Err(StoreFault::new("invalidSummary"));
    }
    Ok(())
}

fn validate_content_type(value: &str) -> StoreResult<()> {
    validate_identifier(value, MAX_CONTENT_TYPE_BYTES, true)?;
    if !matches!(
        value,
        "text/plain"
            | "text/markdown"
            | "application/json"
            | "text/x-diff"
            | "image/png"
            | "image/jpeg"
            | "image/webp"
    ) {
        return Err(StoreFault::new("unsupportedContentType"));
    }
    Ok(())
}

fn validate_query_scope(scope: &AgentEventQueryScope) -> StoreResult<()> {
    match scope {
        AgentEventQueryScope::All => Ok(()),
        AgentEventQueryScope::Workspace { workspace_id } => {
            validate_identifier(workspace_id, MAX_ID_BYTES, false)
        }
        AgentEventQueryScope::Task {
            workspace_id,
            task_id,
        } => {
            validate_identifier(workspace_id, MAX_ID_BYTES, false)?;
            validate_identifier(task_id, MAX_ID_BYTES, false)
        }
    }
}

fn validate_delete_scope(scope: &AgentEventDeleteScope) -> StoreResult<()> {
    match scope {
        AgentEventDeleteScope::All => Ok(()),
        AgentEventDeleteScope::Workspace { workspace_id } => {
            validate_identifier(workspace_id, MAX_ID_BYTES, false)
        }
        AgentEventDeleteScope::Task {
            workspace_id,
            task_id,
        } => {
            validate_identifier(workspace_id, MAX_ID_BYTES, false)?;
            validate_identifier(task_id, MAX_ID_BYTES, false)
        }
    }
}

fn header_matches_query(header: &AgentEventHeaderV1, scope: &AgentEventQueryScope) -> bool {
    match scope {
        AgentEventQueryScope::All => true,
        AgentEventQueryScope::Workspace { workspace_id } => header.workspace_id == *workspace_id,
        AgentEventQueryScope::Task {
            workspace_id,
            task_id,
        } => header.workspace_id == *workspace_id && header.task_id == *task_id,
    }
}

fn header_matches_delete(header: &AgentEventHeaderV1, scope: &AgentEventDeleteScope) -> bool {
    match scope {
        AgentEventDeleteScope::All => true,
        AgentEventDeleteScope::Workspace { workspace_id } => header.workspace_id == *workspace_id,
        AgentEventDeleteScope::Task {
            workspace_id,
            task_id,
        } => header.workspace_id == *workspace_id && header.task_id == *task_id,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_symlink(path: &Path) -> StoreResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(StoreFault::new("metadataUnavailable")),
    }
}

fn ensure_directory(path: &Path) -> StoreResult<()> {
    if is_symlink(path)? {
        return Err(StoreFault::new("unsafeSymlink"));
    }
    fs::create_dir_all(path).map_err(|_| StoreFault::new("createDirectoryFailed"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| StoreFault::new("setPermissionsFailed"))?;
    }
    Ok(())
}

fn secure_write_new(path: &Path, bytes: &[u8]) -> StoreResult<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| StoreFault::new("createFileFailed"))?;
    file.write_all(bytes)
        .map_err(|_| StoreFault::new("writeFailed"))?;
    file.sync_all().map_err(|_| StoreFault::new("syncFailed"))?;
    Ok(file)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> StoreResult<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| StoreFault::new("invalidDataPath"))?;
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    if is_symlink(&tmp)? {
        return Err(StoreFault::new("unsafeSymlink"));
    }
    if tmp.exists() {
        fs::remove_file(&tmp).map_err(|_| StoreFault::new("removeTempFailed"))?;
    }
    let file = secure_write_new(&tmp, bytes)?;
    drop(file);
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(StoreFault::new("atomicReplaceFailed"));
    }
    Ok(())
}

fn serialize_json<T: Serialize>(value: &T) -> StoreResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| StoreFault::new("serializeFailed"))
}

fn read_manifest(path: &Path) -> StoreResult<ManifestV1> {
    if is_symlink(path)? {
        return Err(StoreFault::new("unsafeSymlink"));
    }
    let raw = fs::read(path).map_err(|_| StoreFault::new("manifestReadFailed"))?;
    let manifest: ManifestV1 =
        serde_json::from_slice(&raw).map_err(|_| StoreFault::new("manifestCorrupt"))?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(StoreFault::new("migrationRequired"));
    }
    Ok(manifest)
}

fn write_manifest(root: &Path, manifest: &ManifestV1) -> StoreResult<()> {
    atomic_write(&root.join(MANIFEST_FILE), &serialize_json(manifest)?)
}

fn validate_stored_header(header: &AgentEventHeaderV1) -> StoreResult<()> {
    if header.schema_version != SCHEMA_VERSION
        || header.sequence == 0
        || header.sequence > MAX_SAFE_SEQUENCE
        || header.event_id != event_id(header.sequence)
    {
        return Err(StoreFault::new("headerCorrupt"));
    }
    validate_identifier(&header.client_event_id, MAX_ID_BYTES, false)?;
    validate_identifier(&header.workspace_id, MAX_ID_BYTES, false)?;
    validate_identifier(&header.task_id, MAX_ID_BYTES, false)?;
    if let Some(session_id) = &header.session_id {
        validate_identifier(session_id, MAX_ID_BYTES, false)?;
    }
    validate_summary(&header.summary)?;
    if let Some(payload) = &header.payload {
        validate_content_type(&payload.content_type)?;
        if payload.state != AgentEventPayloadState::Available
            || payload.byte_length > MAX_PAYLOAD_BYTES as u64
            || payload.sha256.len() != 64
            || !payload.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(StoreFault::new("headerCorrupt"));
        }
    }
    Ok(())
}

fn read_headers(root: &Path) -> StoreResult<(Vec<AgentEventHeaderV1>, bool)> {
    let path = root.join(HEADERS_FILE);
    if !path.exists() {
        return Ok((Vec::new(), false));
    }
    if is_symlink(&path)? {
        return Err(StoreFault::new("unsafeSymlink"));
    }
    let file = File::open(&path).map_err(|_| StoreFault::new("headersReadFailed"))?;
    let mut reader = BufReader::new(file);
    let mut headers = Vec::new();
    let mut buffer = Vec::new();
    let mut complete_bytes = 0_u64;
    let mut recovered_partial_tail = false;
    let mut previous_sequence = 0_u64;
    let mut clients = HashSet::new();

    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|_| StoreFault::new("headersReadFailed"))?;
        if read == 0 {
            break;
        }
        if !buffer.ends_with(b"\n") {
            recovered_partial_tail = true;
            break;
        }
        if buffer.len() > MAX_HEADER_BYTES + 1 {
            return Err(StoreFault::new("headerCorrupt"));
        }
        let line = &buffer[..buffer.len() - 1];
        if line.is_empty() {
            return Err(StoreFault::new("headerCorrupt"));
        }
        let header: AgentEventHeaderV1 =
            serde_json::from_slice(line).map_err(|_| StoreFault::new("headerCorrupt"))?;
        validate_stored_header(&header)?;
        if header.sequence <= previous_sequence {
            return Err(StoreFault::new("headerSequenceCorrupt"));
        }
        let client_key = (header.workspace_id.clone(), header.client_event_id.clone());
        if !clients.insert(client_key) {
            return Err(StoreFault::new("headerDuplicateClientId"));
        }
        previous_sequence = header.sequence;
        headers.push(header);
        if headers.len() > MAX_EVENT_COUNT {
            return Err(StoreFault::new("eventQuotaCorrupt"));
        }
        complete_bytes = complete_bytes.saturating_add(read as u64);
    }

    if recovered_partial_tail {
        let writable = OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|_| StoreFault::new("tailRecoveryFailed"))?;
        writable
            .set_len(complete_bytes)
            .map_err(|_| StoreFault::new("tailRecoveryFailed"))?;
        writable
            .sync_all()
            .map_err(|_| StoreFault::new("tailRecoveryFailed"))?;
    }
    Ok((headers, recovered_partial_tail))
}

fn build_client_index(headers: &[AgentEventHeaderV1]) -> HashMap<(String, String), usize> {
    headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            (
                (header.workspace_id.clone(), header.client_event_id.clone()),
                index,
            )
        })
        .collect()
}

fn directory_is_empty(path: &Path) -> StoreResult<bool> {
    let mut entries = fs::read_dir(path).map_err(|_| StoreFault::new("readDirectoryFailed"))?;
    Ok(entries.next().is_none())
}

impl AgentEventStore {
    fn open(root: PathBuf) -> StoreResult<Self> {
        if is_symlink(&root)? {
            return Err(StoreFault::new("unsafeSymlink"));
        }
        let root_existed = root.exists();
        if !root_existed {
            ensure_directory(&root)?;
        } else if !root.is_dir() {
            return Err(StoreFault::new("invalidDataPath"));
        }

        let manifest_path = root.join(MANIFEST_FILE);
        if !manifest_path.exists() {
            if root_existed && !directory_is_empty(&root)? {
                return Err(StoreFault::new("migrationRequired"));
            }
            ensure_directory(&root.join(PAYLOADS_DIR))?;
            write_manifest(
                &root,
                &ManifestV1 {
                    schema_version: SCHEMA_VERSION,
                    delete_generation: 0,
                },
            )?;
        }

        let manifest = read_manifest(&manifest_path)?;
        ensure_directory(&root.join(PAYLOADS_DIR))?;
        let (headers, recovered_partial_tail) = read_headers(&root)?;
        let payload_bytes = headers.iter().try_fold(0_u64, |total, header| {
            total
                .checked_add(
                    header
                        .payload
                        .as_ref()
                        .map_or(0, |payload| payload.byte_length),
                )
                .ok_or_else(|| StoreFault::new("payloadQuotaCorrupt"))
        })?;
        if payload_bytes > MAX_PAYLOAD_TOTAL_BYTES {
            return Err(StoreFault::new("payloadQuotaCorrupt"));
        }
        let client_index = build_client_index(&headers);
        let mut store = Self {
            root,
            manifest,
            headers,
            client_index,
            payload_bytes,
            recovered_partial_tail,
            #[cfg(test)]
            payload_reads: 0,
        };
        store.resume_pending_delete()?;
        store.cleanup_orphans()?;
        Ok(store)
    }

    fn cleanup_orphans(&self) -> StoreResult<()> {
        let payload_dir = self.root.join(PAYLOADS_DIR);
        let referenced: HashSet<String> = self
            .headers
            .iter()
            .filter(|header| header.payload.is_some())
            .map(|header| format!("{}.json", header.event_id))
            .collect();
        for entry in
            fs::read_dir(&payload_dir).map_err(|_| StoreFault::new("readPayloadDirFailed"))?
        {
            let entry = entry.map_err(|_| StoreFault::new("readPayloadDirFailed"))?;
            let file_type = entry
                .file_type()
                .map_err(|_| StoreFault::new("readPayloadDirFailed"))?;
            if file_type.is_symlink() || !file_type.is_file() {
                return Err(StoreFault::new("unsafePayloadEntry"));
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.starts_with('.') && name.ends_with(".tmp")) || !referenced.contains(&name) {
                fs::remove_file(entry.path())
                    .map_err(|_| StoreFault::new("orphanCleanupFailed"))?;
            }
        }
        Ok(())
    }

    fn append(&mut self, request: AgentEventAppendRequest) -> StoreResult<AgentEventAppendResult> {
        validate_identifier(&request.client_event_id, MAX_ID_BYTES, false)?;
        validate_identifier(&request.workspace_id, MAX_ID_BYTES, false)?;
        validate_identifier(&request.task_id, MAX_ID_BYTES, false)?;
        if let Some(session_id) = &request.session_id {
            validate_identifier(session_id, MAX_ID_BYTES, false)?;
        }
        validate_summary(&request.summary)?;
        let recorded_at_ms = now_ms();
        let occurred_at_ms = request.occurred_at_ms.unwrap_or(recorded_at_ms);
        if occurred_at_ms < 0 || occurred_at_ms > recorded_at_ms.saturating_add(86_400_000) {
            return Err(StoreFault::new("invalidOccurredAt"));
        }

        let payload_input = request.private_payload.as_ref();
        let requested_payload_meta = if let Some(payload) = payload_input {
            validate_content_type(&payload.content_type)?;
            if payload.body.len() > MAX_PAYLOAD_BYTES {
                return Err(StoreFault::new("payloadTooLarge"));
            }
            Some(AgentEventPayloadMetaV1 {
                state: AgentEventPayloadState::Available,
                content_type: payload.content_type.clone(),
                byte_length: payload.body.len() as u64,
                sha256: sha256_hex(payload.body.as_bytes()),
            })
        } else {
            None
        };

        let client_key = (
            request.workspace_id.clone(),
            request.client_event_id.clone(),
        );
        if let Some(index) = self.client_index.get(&client_key) {
            let existing = self
                .headers
                .get(*index)
                .ok_or_else(|| StoreFault::new("indexCorrupt"))?;
            if existing.task_id != request.task_id
                || existing.session_id != request.session_id
                || existing.kind != request.kind
                || existing.source != request.source
                || (request.occurred_at_ms.is_some() && existing.occurred_at_ms != occurred_at_ms)
                || existing.summary != request.summary
                || existing.payload != requested_payload_meta
            {
                return Err(StoreFault::new("idempotencyConflict"));
            }
            return Ok(AgentEventAppendResult {
                status: AgentEventAppendStatus::Duplicate,
                header: existing.clone(),
            });
        }

        if self.headers.len() >= MAX_EVENT_COUNT {
            return Err(StoreFault::new("eventQuotaExceeded"));
        }
        let requested_payload_bytes = requested_payload_meta
            .as_ref()
            .map_or(0, |payload| payload.byte_length);
        if self
            .payload_bytes
            .checked_add(requested_payload_bytes)
            .filter(|total| *total <= MAX_PAYLOAD_TOTAL_BYTES)
            .is_none()
        {
            return Err(StoreFault::new("payloadQuotaExceeded"));
        }

        let sequence = self
            .headers
            .last()
            .map_or(1, |header| header.sequence.saturating_add(1));
        if sequence > MAX_SAFE_SEQUENCE {
            return Err(StoreFault::new("sequenceExhausted"));
        }
        let event_id = event_id(sequence);
        let header = AgentEventHeaderV1 {
            schema_version: SCHEMA_VERSION,
            sequence,
            event_id: event_id.clone(),
            client_event_id: request.client_event_id,
            workspace_id: request.workspace_id,
            task_id: request.task_id,
            session_id: request.session_id,
            kind: request.kind,
            source: request.source,
            occurred_at_ms,
            recorded_at_ms,
            summary: request.summary,
            payload: requested_payload_meta,
        };
        let mut header_line = serialize_json(&header)?;
        if header_line.len() > MAX_HEADER_BYTES {
            return Err(StoreFault::new("headerTooLarge"));
        }
        header_line.push(b'\n');

        let payload_path = self
            .root
            .join(PAYLOADS_DIR)
            .join(format!("{event_id}.json"));
        let mut wrote_payload = false;
        if let Some(payload) = payload_input {
            let stored = StoredPayloadV1 {
                schema_version: SCHEMA_VERSION,
                event_id: event_id.clone(),
                content_type: payload.content_type.clone(),
                body: payload.body.clone(),
            };
            atomic_write(&payload_path, &serialize_json(&stored)?)?;
            wrote_payload = true;
        }

        let header_path = self.root.join(HEADERS_FILE);
        let append_result = (|| -> StoreResult<()> {
            if is_symlink(&header_path)? {
                return Err(StoreFault::new("unsafeSymlink"));
            }
            let mut options = OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&header_path)
                .map_err(|_| StoreFault::new("headersAppendFailed"))?;
            file.write_all(&header_line)
                .map_err(|_| StoreFault::new("headersAppendFailed"))?;
            file.sync_all()
                .map_err(|_| StoreFault::new("headersSyncFailed"))
        })();
        if let Err(error) = append_result {
            if wrote_payload {
                let _ = fs::remove_file(&payload_path);
            }
            return Err(error);
        }

        self.payload_bytes = self.payload_bytes.saturating_add(requested_payload_bytes);
        let index = self.headers.len();
        self.client_index.insert(
            (header.workspace_id.clone(), header.client_event_id.clone()),
            index,
        );
        self.headers.push(header.clone());
        Ok(AgentEventAppendResult {
            status: AgentEventAppendStatus::Appended,
            header,
        })
    }

    fn list(&self, request: AgentEventListRequest) -> StoreResult<AgentEventPage> {
        validate_query_scope(&request.scope)?;
        let limit = request.limit.unwrap_or(DEFAULT_PAGE_SIZE);
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(StoreFault::new("invalidPageSize"));
        }
        let (snapshot_upper_bound, before_sequence) = if let Some(cursor) = request.cursor {
            let decoded = URL_SAFE_NO_PAD
                .decode(cursor)
                .map_err(|_| StoreFault::new("invalidCursor"))?;
            let cursor: CursorV1 =
                serde_json::from_slice(&decoded).map_err(|_| StoreFault::new("invalidCursor"))?;
            if cursor.version != 1
                || cursor.delete_generation != self.manifest.delete_generation
                || cursor.scope != request.scope
                || cursor.before_sequence > cursor.snapshot_upper_bound.saturating_add(1)
            {
                return Err(StoreFault::new("invalidCursor"));
            }
            (cursor.snapshot_upper_bound, cursor.before_sequence)
        } else {
            let snapshot = self.headers.last().map_or(0, |header| header.sequence);
            (snapshot, snapshot.saturating_add(1))
        };

        let mut items = Vec::with_capacity(limit);
        for header in self.headers.iter().rev() {
            if header.sequence > snapshot_upper_bound || header.sequence >= before_sequence {
                continue;
            }
            if header_matches_query(header, &request.scope) {
                items.push(header.clone());
                if items.len() == limit {
                    break;
                }
            }
        }

        let next_cursor = items.last().and_then(|last| {
            let has_more = self.headers.iter().rev().any(|header| {
                header.sequence <= snapshot_upper_bound
                    && header.sequence < last.sequence
                    && header_matches_query(header, &request.scope)
            });
            if !has_more {
                return None;
            }
            let cursor = CursorV1 {
                version: 1,
                delete_generation: self.manifest.delete_generation,
                snapshot_upper_bound,
                before_sequence: last.sequence,
                scope: request.scope.clone(),
            };
            serialize_json(&cursor)
                .ok()
                .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        });

        Ok(AgentEventPage {
            items,
            next_cursor,
            snapshot_upper_bound,
        })
    }

    fn payload(&mut self, requested_event_id: &str) -> StoreResult<AgentEventPayload> {
        validate_identifier(requested_event_id, MAX_ID_BYTES, false)?;
        let header = self
            .headers
            .iter()
            .find(|header| header.event_id == requested_event_id)
            .ok_or_else(|| StoreFault::new("eventNotFound"))?;
        let meta = header
            .payload
            .as_ref()
            .ok_or_else(|| StoreFault::new("payloadNotAvailable"))?;
        let path = self
            .root
            .join(PAYLOADS_DIR)
            .join(format!("{requested_event_id}.json"));
        if is_symlink(&path)? {
            return Err(StoreFault::new("unsafeSymlink"));
        }
        let metadata = fs::metadata(&path).map_err(|_| StoreFault::new("payloadMissing"))?;
        if !metadata.is_file() || metadata.len() > (MAX_PAYLOAD_BYTES as u64).saturating_add(4096) {
            return Err(StoreFault::new("payloadCorrupt"));
        }
        let mut file = File::open(&path).map_err(|_| StoreFault::new("payloadMissing"))?;
        let mut raw = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut raw)
            .map_err(|_| StoreFault::new("payloadReadFailed"))?;
        #[cfg(test)]
        {
            self.payload_reads = self.payload_reads.saturating_add(1);
        }
        let stored: StoredPayloadV1 =
            serde_json::from_slice(&raw).map_err(|_| StoreFault::new("payloadCorrupt"))?;
        if stored.schema_version != SCHEMA_VERSION
            || stored.event_id != requested_event_id
            || stored.content_type != meta.content_type
            || stored.body.len() as u64 != meta.byte_length
            || sha256_hex(stored.body.as_bytes()) != meta.sha256
        {
            return Err(StoreFault::new("payloadCorrupt"));
        }
        Ok(AgentEventPayload {
            event_id: requested_event_id.to_string(),
            content_type: stored.content_type,
            body: stored.body,
            byte_length: meta.byte_length,
            sha256: meta.sha256.clone(),
        })
    }

    fn delete(&mut self, request: AgentEventDeleteRequest) -> StoreResult<AgentEventDeleteResult> {
        if !request.confirmed {
            return Err(StoreFault::new("confirmationRequired"));
        }
        validate_delete_scope(&request.scope)?;
        let events: Vec<PendingDeleteEvent> = self
            .headers
            .iter()
            .filter(|header| header_matches_delete(header, &request.scope))
            .map(|header| PendingDeleteEvent {
                sequence: header.sequence,
                had_payload: header.payload.is_some(),
                payload_bytes: header
                    .payload
                    .as_ref()
                    .map_or(0, |payload| payload.byte_length),
            })
            .collect();
        if events.is_empty() {
            return Ok(AgentEventDeleteResult {
                counts_accurate: true,
                ..AgentEventDeleteResult::default()
            });
        }
        let pending = PendingDeleteV1 {
            schema_version: SCHEMA_VERSION,
            next_generation: self.manifest.delete_generation.saturating_add(1),
            events,
        };
        atomic_write(
            &self.root.join(DELETE_PENDING_FILE),
            &serialize_json(&pending)?,
        )?;
        self.apply_pending_delete(&pending)
    }

    fn resume_pending_delete(&mut self) -> StoreResult<()> {
        let path = self.root.join(DELETE_PENDING_FILE);
        if !path.exists() {
            return Ok(());
        }
        if is_symlink(&path)? {
            return Err(StoreFault::new("unsafeSymlink"));
        }
        let raw = fs::read(&path).map_err(|_| StoreFault::new("deleteJournalReadFailed"))?;
        let pending: PendingDeleteV1 =
            serde_json::from_slice(&raw).map_err(|_| StoreFault::new("deleteJournalCorrupt"))?;
        if pending.schema_version != SCHEMA_VERSION
            || pending.next_generation < self.manifest.delete_generation
            || pending.events.len() > MAX_EVENT_COUNT
        {
            return Err(StoreFault::new("deleteJournalCorrupt"));
        }
        self.apply_pending_delete(&pending)?;
        Ok(())
    }

    fn apply_pending_delete(
        &mut self,
        pending: &PendingDeleteV1,
    ) -> StoreResult<AgentEventDeleteResult> {
        let sequences: HashSet<u64> = pending.events.iter().map(|event| event.sequence).collect();
        let remaining: Vec<AgentEventHeaderV1> = self
            .headers
            .iter()
            .filter(|header| !sequences.contains(&header.sequence))
            .cloned()
            .collect();
        let mut header_bytes = Vec::new();
        for header in &remaining {
            let line = serialize_json(header)?;
            if line.len() > MAX_HEADER_BYTES {
                return Err(StoreFault::new("headerCorrupt"));
            }
            header_bytes.extend_from_slice(&line);
            header_bytes.push(b'\n');
        }
        atomic_write(&self.root.join(HEADERS_FILE), &header_bytes)?;

        let mut deleted_payloads = 0_u64;
        for event in &pending.events {
            if !event.had_payload {
                continue;
            }
            let path = self
                .root
                .join(PAYLOADS_DIR)
                .join(format!("{}.json", event_id(event.sequence)));
            if is_symlink(&path)? {
                return Err(StoreFault::new("unsafeSymlink"));
            }
            match fs::remove_file(&path) {
                Ok(()) => deleted_payloads = deleted_payloads.saturating_add(1),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(StoreFault::new("payloadDeleteFailed")),
            }
        }

        self.manifest.delete_generation = pending.next_generation;
        write_manifest(&self.root, &self.manifest)?;
        fs::remove_file(self.root.join(DELETE_PENDING_FILE))
            .map_err(|_| StoreFault::new("deleteJournalCleanupFailed"))?;

        self.headers = remaining;
        self.client_index = build_client_index(&self.headers);
        let freed_payload_bytes = pending.events.iter().fold(0_u64, |total, event| {
            total.saturating_add(event.payload_bytes)
        });
        self.payload_bytes = self.payload_bytes.saturating_sub(freed_payload_bytes);
        Ok(AgentEventDeleteResult {
            deleted_headers: pending.events.len() as u64,
            deleted_payloads,
            freed_payload_bytes,
            counts_accurate: true,
        })
    }
}

fn classify_open_fault(fault: StoreFault) -> StoreMode {
    match fault.code {
        "migrationRequired" => StoreMode::MigrationRequired(fault.code),
        "manifestCorrupt"
        | "headerCorrupt"
        | "headerSequenceCorrupt"
        | "headerDuplicateClientId"
        | "payloadQuotaCorrupt"
        | "eventQuotaCorrupt"
        | "deleteJournalCorrupt" => StoreMode::Corrupt(fault.code),
        _ => StoreMode::Unavailable(fault.code),
    }
}

impl AgentEventStoreState {
    pub fn from_app(app: &AppHandle) -> Self {
        match app.path().app_local_data_dir() {
            Ok(path) => Self::from_base_dir(path.join("agent-events")),
            Err(_) => Self::unavailable(PathBuf::from("agent-events"), "dataLocationUnavailable"),
        }
    }

    fn from_base_dir(base_dir: PathBuf) -> Self {
        let root = base_dir.join("v1");
        let disabled_marker = base_dir.join(DISABLED_FILE);
        let mode = if disabled_marker.exists() {
            if is_symlink(&disabled_marker).unwrap_or(true) {
                StoreMode::Unavailable("unsafeSymlink")
            } else {
                StoreMode::Disabled
            }
        } else {
            AgentEventStore::open(root.clone())
                .map(StoreMode::Ready)
                .unwrap_or_else(classify_open_fault)
        };
        Self {
            inner: Arc::new(Mutex::new(AgentEventStoreInner {
                base_dir,
                root,
                disabled_marker,
                mode,
            })),
        }
    }

    fn unavailable(base_dir: PathBuf, code: &'static str) -> Self {
        let root = base_dir.join("v1");
        let disabled_marker = base_dir.join(DISABLED_FILE);
        Self {
            inner: Arc::new(Mutex::new(AgentEventStoreInner {
                base_dir,
                root,
                disabled_marker,
                mode: StoreMode::Unavailable(code),
            })),
        }
    }

    fn status(&self) -> AgentEventStoreStatus {
        let inner = self.inner.lock();
        let (capability, event_count, payload_bytes, recovered_partial_tail, error_code) =
            match &inner.mode {
                StoreMode::Ready(store) => (
                    AgentEventStoreCapabilityState::Enabled,
                    Some(store.headers.len()),
                    Some(store.payload_bytes),
                    store.recovered_partial_tail,
                    None,
                ),
                StoreMode::Disabled => (
                    AgentEventStoreCapabilityState::Disabled,
                    None,
                    None,
                    false,
                    None,
                ),
                StoreMode::Corrupt(code) => (
                    AgentEventStoreCapabilityState::Corrupt,
                    None,
                    None,
                    false,
                    Some((*code).to_string()),
                ),
                StoreMode::MigrationRequired(code) => (
                    AgentEventStoreCapabilityState::MigrationRequired,
                    None,
                    None,
                    false,
                    Some((*code).to_string()),
                ),
                StoreMode::Unavailable(code) => (
                    AgentEventStoreCapabilityState::Unavailable,
                    None,
                    None,
                    false,
                    Some((*code).to_string()),
                ),
            };
        AgentEventStoreStatus {
            capability,
            schema_version: SCHEMA_VERSION,
            data_location: inner.root.to_string_lossy().to_string(),
            event_count,
            payload_bytes,
            recovered_partial_tail,
            error_code,
            retention: AgentEventRetentionPolicy {
                max_events: MAX_EVENT_COUNT,
                max_payload_bytes: MAX_PAYLOAD_TOTAL_BYTES,
                auto_prune: false,
            },
            export: AgentEventExportPolicy {
                supported: false,
                background_export: false,
            },
            privacy: AgentEventPrivacyPolicy {
                header_contains_private_body: false,
                payload_requires_explicit_read: true,
                telemetry_upload: false,
            },
        }
    }
}

fn mode_error(mode: &StoreMode) -> StoreFault {
    match mode {
        StoreMode::Ready(_) => StoreFault::new("internalStateError"),
        StoreMode::Disabled => StoreFault::new("capabilityDisabled"),
        StoreMode::Corrupt(_) => StoreFault::new("storeCorrupt"),
        StoreMode::MigrationRequired(_) => StoreFault::new("migrationRequired"),
        StoreMode::Unavailable(_) => StoreFault::new("storeUnavailable"),
    }
}

fn fault_string(fault: StoreFault) -> String {
    fault.code.to_string()
}

fn mutation_fault_requires_reopen(code: &str) -> bool {
    matches!(
        code,
        "headersAppendFailed"
            | "headersSyncFailed"
            | "atomicReplaceFailed"
            | "payloadDeleteFailed"
            | "deleteJournalCleanupFailed"
            | "syncFailed"
    )
}

fn remove_store_root(root: &Path) -> StoreResult<u64> {
    if is_symlink(root)? {
        return Err(StoreFault::new("unsafeSymlink"));
    }
    if !root.exists() {
        return Ok(0);
    }
    let mut bytes = 0_u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(&path).map_err(|_| StoreFault::new("readDirectoryFailed"))? {
            let entry = entry.map_err(|_| StoreFault::new("readDirectoryFailed"))?;
            let file_type = entry
                .file_type()
                .map_err(|_| StoreFault::new("readDirectoryFailed"))?;
            if file_type.is_symlink() {
                return Err(StoreFault::new("unsafeSymlink"));
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                bytes = bytes.saturating_add(
                    entry
                        .metadata()
                        .map_err(|_| StoreFault::new("readDirectoryFailed"))?
                        .len(),
                );
            } else {
                return Err(StoreFault::new("unsafeDataEntry"));
            }
        }
    }
    fs::remove_dir_all(root).map_err(|_| StoreFault::new("clearFailed"))?;
    Ok(bytes)
}

async fn run_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> StoreResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "workerFailed".to_string())?
        .map_err(fault_string)
}

#[tauri::command]
pub fn agent_event_store_status(state: State<'_, AgentEventStoreState>) -> AgentEventStoreStatus {
    state.status()
}

#[tauri::command]
pub async fn agent_event_append(
    app: AppHandle,
    state: State<'_, AgentEventStoreState>,
    request: AgentEventAppendRequest,
) -> Result<AgentEventAppendResult, String> {
    let inner = state.inner.clone();
    let result = run_blocking(move || {
        let mut inner = inner.lock();
        let root = inner.root.clone();
        let result = match &mut inner.mode {
            StoreMode::Ready(store) => store.append(request),
            mode => Err(mode_error(mode)),
        };
        if result
            .as_ref()
            .err()
            .is_some_and(|fault| mutation_fault_requires_reopen(fault.code))
        {
            inner.mode = AgentEventStore::open(root)
                .map(StoreMode::Ready)
                .unwrap_or_else(classify_open_fault);
        }
        result
    })
    .await?;
    if result.status == AgentEventAppendStatus::Appended {
        let _ = app.emit(APPENDED_EVENT, result.header.clone());
    }
    Ok(result)
}

#[tauri::command]
pub async fn agent_event_list(
    state: State<'_, AgentEventStoreState>,
    request: AgentEventListRequest,
) -> Result<AgentEventPage, String> {
    let inner = state.inner.clone();
    run_blocking(move || {
        let inner = inner.lock();
        match &inner.mode {
            StoreMode::Ready(store) => store.list(request),
            mode => Err(mode_error(mode)),
        }
    })
    .await
}

#[tauri::command]
pub async fn agent_event_payload(
    state: State<'_, AgentEventStoreState>,
    event_id: String,
) -> Result<AgentEventPayload, String> {
    let inner = state.inner.clone();
    run_blocking(move || {
        let mut inner = inner.lock();
        match &mut inner.mode {
            StoreMode::Ready(store) => store.payload(&event_id),
            mode => Err(mode_error(mode)),
        }
    })
    .await
}

#[tauri::command]
pub async fn agent_event_delete(
    state: State<'_, AgentEventStoreState>,
    request: AgentEventDeleteRequest,
) -> Result<AgentEventDeleteResult, String> {
    let inner = state.inner.clone();
    run_blocking(move || {
        let mut inner = inner.lock();
        if !request.confirmed {
            return Err(StoreFault::new("confirmationRequired"));
        }
        validate_delete_scope(&request.scope)?;
        let root = inner.root.clone();
        match &mut inner.mode {
            StoreMode::Ready(store) => {
                let result = store.delete(request);
                if result
                    .as_ref()
                    .err()
                    .is_some_and(|fault| mutation_fault_requires_reopen(fault.code))
                {
                    inner.mode = AgentEventStore::open(root)
                        .map(StoreMode::Ready)
                        .unwrap_or_else(classify_open_fault);
                }
                result
            }
            StoreMode::Disabled | StoreMode::Corrupt(_) | StoreMode::MigrationRequired(_) => {
                if request.scope != AgentEventDeleteScope::All {
                    return Err(mode_error(&inner.mode));
                }
                let freed = remove_store_root(&inner.root)?;
                if matches!(inner.mode, StoreMode::Disabled) {
                    return Ok(AgentEventDeleteResult {
                        freed_payload_bytes: freed,
                        counts_accurate: false,
                        ..AgentEventDeleteResult::default()
                    });
                }
                let generation = now_ms().max(1) as u64;
                inner.mode = AgentEventStore::open(inner.root.clone())
                    .map(|mut store| {
                        store.manifest.delete_generation = generation;
                        write_manifest(&store.root, &store.manifest)?;
                        Ok(StoreMode::Ready(store))
                    })
                    .and_then(|mode| mode)
                    .unwrap_or_else(classify_open_fault);
                Ok(AgentEventDeleteResult {
                    freed_payload_bytes: freed,
                    counts_accurate: false,
                    ..AgentEventDeleteResult::default()
                })
            }
            StoreMode::Unavailable(_) => Err(mode_error(&inner.mode)),
        }
    })
    .await
}

#[tauri::command]
pub async fn agent_event_store_set_enabled(
    state: State<'_, AgentEventStoreState>,
    enabled: bool,
) -> Result<AgentEventStoreStatus, String> {
    let cloned_state = state.inner.clone();
    let state_for_status = state.inner.clone();
    run_blocking(move || {
        let mut inner = cloned_state.lock();
        if enabled {
            if inner.disabled_marker.exists() {
                if is_symlink(&inner.disabled_marker)? {
                    return Err(StoreFault::new("unsafeSymlink"));
                }
                fs::remove_file(&inner.disabled_marker)
                    .map_err(|_| StoreFault::new("enableFailed"))?;
            }
            inner.mode = AgentEventStore::open(inner.root.clone())
                .map(StoreMode::Ready)
                .unwrap_or_else(classify_open_fault);
        } else {
            ensure_directory(&inner.base_dir)?;
            if is_symlink(&inner.disabled_marker)? {
                return Err(StoreFault::new("unsafeSymlink"));
            }
            if !inner.disabled_marker.exists() {
                let file = secure_write_new(&inner.disabled_marker, b"disabled\n")?;
                drop(file);
            }
            inner.mode = StoreMode::Disabled;
        }
        Ok(())
    })
    .await?;
    let temporary = AgentEventStoreState {
        inner: state_for_status,
    };
    Ok(temporary.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn temp_base(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "tunara-agent-event-store-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn typed_ipc_scopes_accept_camel_case_fields() {
        let query: AgentEventQueryScope = serde_json::from_value(serde_json::json!({
            "type": "task",
            "workspaceId": "workspace-a",
            "taskId": "task-a"
        }))
        .expect("camelCase query scope");
        assert_eq!(
            query,
            AgentEventQueryScope::Task {
                workspace_id: "workspace-a".to_string(),
                task_id: "task-a".to_string(),
            }
        );

        let delete: AgentEventDeleteScope = serde_json::from_value(serde_json::json!({
            "type": "workspace",
            "workspaceId": "workspace-a"
        }))
        .expect("camelCase delete scope");
        assert_eq!(
            delete,
            AgentEventDeleteScope::Workspace {
                workspace_id: "workspace-a".to_string(),
            }
        );
    }

    fn append_request(
        index: usize,
        workspace: &str,
        task: &str,
        payload: bool,
    ) -> AgentEventAppendRequest {
        AgentEventAppendRequest {
            client_event_id: format!("client-{index}"),
            workspace_id: workspace.to_string(),
            task_id: task.to_string(),
            session_id: Some("session-1".to_string()),
            kind: AgentEventKind::AgentStatus,
            source: AgentEventSource::Hook,
            occurred_at_ms: Some(1_700_000_000_000 + index as i64),
            summary: format!("event {index}"),
            private_payload: payload.then(|| AgentEventPrivatePayloadInput {
                content_type: "text/plain".to_string(),
                body: format!("private payload {index}"),
            }),
        }
    }

    fn fixture_header(index: usize, with_payload: bool) -> AgentEventHeaderV1 {
        let sequence = index as u64 + 1;
        let body = format!("fixture-private-{index}");
        AgentEventHeaderV1 {
            schema_version: SCHEMA_VERSION,
            sequence,
            event_id: event_id(sequence),
            client_event_id: format!("fixture-client-{index}"),
            workspace_id: "workspace-fixture".to_string(),
            task_id: format!("task-{}", index % 4),
            session_id: Some(format!("session-{}", index % 8)),
            kind: AgentEventKind::OutputSummary,
            source: AgentEventSource::System,
            occurred_at_ms: 1_700_000_000_000 + index as i64,
            recorded_at_ms: 1_700_000_000_000 + index as i64,
            summary: format!("fixture event {index}"),
            payload: with_payload.then(|| AgentEventPayloadMetaV1 {
                state: AgentEventPayloadState::Available,
                content_type: "text/plain".to_string(),
                byte_length: body.len() as u64,
                sha256: sha256_hex(body.as_bytes()),
            }),
        }
    }

    fn write_fixture(base: &Path, count: usize, payload_every: usize) -> PathBuf {
        let root = base.join("v1");
        ensure_directory(&root).expect("create fixture root");
        ensure_directory(&root.join(PAYLOADS_DIR)).expect("create fixture payload dir");
        write_manifest(
            &root,
            &ManifestV1 {
                schema_version: SCHEMA_VERSION,
                delete_generation: 0,
            },
        )
        .expect("write fixture manifest");
        let mut lines = Vec::new();
        for index in 0..count {
            let with_payload = payload_every > 0 && index % payload_every == 0;
            let header = fixture_header(index, with_payload);
            lines.extend_from_slice(&serialize_json(&header).expect("serialize fixture header"));
            lines.push(b'\n');
            if with_payload {
                let payload = StoredPayloadV1 {
                    schema_version: SCHEMA_VERSION,
                    event_id: header.event_id.clone(),
                    content_type: "text/plain".to_string(),
                    body: format!("fixture-private-{index}"),
                };
                atomic_write(
                    &root
                        .join(PAYLOADS_DIR)
                        .join(format!("{}.json", header.event_id)),
                    &serialize_json(&payload).expect("serialize fixture payload"),
                )
                .expect("write fixture payload");
            }
        }
        atomic_write(&root.join(HEADERS_FILE), &lines).expect("write fixture headers");
        root
    }

    fn collect_all(store: &AgentEventStore, scope: AgentEventQueryScope) -> Vec<u64> {
        let mut cursor = None;
        let mut sequences = Vec::new();
        loop {
            let page = store
                .list(AgentEventListRequest {
                    scope: scope.clone(),
                    cursor,
                    limit: Some(MAX_PAGE_SIZE),
                })
                .expect("list fixture page");
            sequences.extend(page.items.iter().map(|header| header.sequence));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        sequences
    }

    #[test]
    fn append_is_durable_idempotent_and_payload_is_explicit() {
        let base = temp_base("append");
        let root = base.join("v1");
        let mut store = AgentEventStore::open(root.clone()).expect("open store");
        let request = append_request(1, "workspace-a", "task-a", true);
        let first = store.append(request.clone()).expect("append event");
        assert_eq!(first.status, AgentEventAppendStatus::Appended);
        let duplicate = store.append(request).expect("retry append");
        assert_eq!(duplicate.status, AgentEventAppendStatus::Duplicate);
        assert_eq!(first.header.sequence, duplicate.header.sequence);
        assert_eq!(store.headers.len(), 1);
        assert_eq!(store.payload_reads, 0);
        let body = store
            .payload(&first.header.event_id)
            .expect("read explicit payload");
        assert_eq!(body.body, "private payload 1");
        assert_eq!(store.payload_reads, 1);
        drop(store);
        let reopened = AgentEventStore::open(root).expect("reopen store");
        assert_eq!(reopened.headers.len(), 1);
        assert_eq!(reopened.headers[0].sequence, first.header.sequence);
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn ten_thousand_headers_page_once_without_payload_reads() {
        let base = temp_base("ten-thousand");
        let root = write_fixture(&base, 10_000, 250);
        let store = AgentEventStore::open(root).expect("open fixture");
        let sequences = collect_all(&store, AgentEventQueryScope::All);
        assert_eq!(sequences.len(), 10_000);
        assert_eq!(sequences.first(), Some(&10_000));
        assert_eq!(sequences.last(), Some(&1));
        let unique: HashSet<u64> = sequences.iter().copied().collect();
        assert_eq!(unique.len(), 10_000);
        assert_eq!(store.payload_reads, 0);
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn cursor_freezes_snapshot_and_rejects_scope_or_generation_reuse() {
        let base = temp_base("cursor");
        let mut store = AgentEventStore::open(base.join("v1")).expect("open store");
        for index in 0..5 {
            store
                .append(append_request(index, "workspace-a", "task-a", false))
                .expect("append event");
        }
        let first = store
            .list(AgentEventListRequest {
                scope: AgentEventQueryScope::All,
                cursor: None,
                limit: Some(2),
            })
            .expect("first page");
        store
            .append(append_request(99, "workspace-a", "task-a", false))
            .expect("append after first page");
        let cursor = first.next_cursor.clone().expect("next cursor");
        let second = store
            .list(AgentEventListRequest {
                scope: AgentEventQueryScope::All,
                cursor: Some(cursor.clone()),
                limit: Some(10),
            })
            .expect("second page");
        assert_eq!(second.snapshot_upper_bound, 5);
        assert_eq!(
            second
                .items
                .iter()
                .map(|item| item.sequence)
                .collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        let wrong_scope = store.list(AgentEventListRequest {
            scope: AgentEventQueryScope::Workspace {
                workspace_id: "workspace-a".to_string(),
            },
            cursor: Some(cursor.clone()),
            limit: Some(2),
        });
        assert_eq!(
            wrong_scope.expect_err("scope mismatch").code,
            "invalidCursor"
        );
        store
            .delete(AgentEventDeleteRequest {
                scope: AgentEventDeleteScope::Task {
                    workspace_id: "workspace-a".to_string(),
                    task_id: "task-a".to_string(),
                },
                confirmed: true,
            })
            .expect("delete task");
        let stale = store.list(AgentEventListRequest {
            scope: AgentEventQueryScope::All,
            cursor: Some(cursor),
            limit: Some(2),
        });
        assert_eq!(
            stale.expect_err("generation mismatch").code,
            "invalidCursor"
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn restart_continues_sequence_and_recovers_partial_tail() {
        let base = temp_base("restart");
        let root = base.join("v1");
        let mut store = AgentEventStore::open(root.clone()).expect("open store");
        store
            .append(append_request(1, "workspace-a", "task-a", false))
            .expect("append event");
        drop(store);
        let mut file = OpenOptions::new()
            .append(true)
            .open(root.join(HEADERS_FILE))
            .expect("open headers");
        file.write_all(b"{\"partial\":")
            .expect("write partial tail");
        file.sync_all().expect("sync partial tail");
        drop(file);
        let mut reopened = AgentEventStore::open(root.clone()).expect("recover store");
        assert!(reopened.recovered_partial_tail);
        let next = reopened
            .append(append_request(2, "workspace-a", "task-a", false))
            .expect("append after recovery");
        assert_eq!(next.header.sequence, 2);
        drop(reopened);
        let final_store = AgentEventStore::open(root).expect("reopen recovered store");
        assert_eq!(final_store.headers.len(), 2);
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn corrupt_middle_and_future_schema_fail_closed() {
        let base = temp_base("corrupt");
        let root = write_fixture(&base, 3, 0);
        let raw = fs::read_to_string(root.join(HEADERS_FILE)).expect("read headers");
        let mut lines: Vec<&str> = raw.lines().collect();
        lines[1] = "{bad-json}";
        fs::write(root.join(HEADERS_FILE), format!("{}\n", lines.join("\n")))
            .expect("corrupt middle");
        assert_eq!(
            AgentEventStore::open(root.clone())
                .expect_err("middle corruption must fail")
                .code,
            "headerCorrupt"
        );
        fs::remove_dir_all(&root).expect("remove corrupt root");
        ensure_directory(&root).expect("recreate root");
        ensure_directory(&root.join(PAYLOADS_DIR)).expect("recreate payload dir");
        atomic_write(
            &root.join(MANIFEST_FILE),
            br#"{"schemaVersion":99,"deleteGeneration":0}"#,
        )
        .expect("write future manifest");
        assert_eq!(
            AgentEventStore::open(root)
                .expect_err("future schema must fail")
                .code,
            "migrationRequired"
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn payload_corruption_does_not_block_header_paging() {
        let base = temp_base("payload-corrupt");
        let root = base.join("v1");
        let mut store = AgentEventStore::open(root.clone()).expect("open store");
        let appended = store
            .append(append_request(1, "workspace-a", "task-a", true))
            .expect("append payload event");
        fs::write(
            root.join(PAYLOADS_DIR)
                .join(format!("{}.json", appended.header.event_id)),
            b"{}",
        )
        .expect("corrupt payload");
        let page = store
            .list(AgentEventListRequest {
                scope: AgentEventQueryScope::All,
                cursor: None,
                limit: None,
            })
            .expect("header page survives payload corruption");
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            store
                .payload(&appended.header.event_id)
                .expect_err("payload must fail")
                .code,
            "payloadCorrupt"
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn delete_is_exact_physical_and_restart_safe() {
        let base = temp_base("delete");
        let root = base.join("v1");
        let mut store = AgentEventStore::open(root.clone()).expect("open store");
        let a = store
            .append(append_request(1, "workspace-a", "task-a", true))
            .expect("append a");
        let b = store
            .append(append_request(2, "workspace-a", "task-b", true))
            .expect("append b");
        let c = store
            .append(append_request(3, "workspace-b", "task-a", true))
            .expect("append c");
        let result = store
            .delete(AgentEventDeleteRequest {
                scope: AgentEventDeleteScope::Task {
                    workspace_id: "workspace-a".to_string(),
                    task_id: "task-a".to_string(),
                },
                confirmed: true,
            })
            .expect("delete exact task");
        assert_eq!(result.deleted_headers, 1);
        assert!(!root
            .join(PAYLOADS_DIR)
            .join(format!("{}.json", a.header.event_id))
            .exists());
        assert!(root
            .join(PAYLOADS_DIR)
            .join(format!("{}.json", b.header.event_id))
            .exists());
        assert!(root
            .join(PAYLOADS_DIR)
            .join(format!("{}.json", c.header.event_id))
            .exists());
        drop(store);
        let reopened = AgentEventStore::open(root).expect("reopen after delete");
        assert_eq!(reopened.headers.len(), 2);
        assert_eq!(reopened.headers[0].workspace_id, "workspace-a");
        assert_eq!(reopened.headers[0].task_id, "task-b");
        assert_eq!(reopened.headers[1].workspace_id, "workspace-b");
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn pending_delete_is_resumed_idempotently_on_restart() {
        let base = temp_base("delete-resume");
        let root = base.join("v1");
        let mut store = AgentEventStore::open(root.clone()).expect("open store");
        let first = store
            .append(append_request(1, "workspace-a", "task-a", true))
            .expect("append first");
        store
            .append(append_request(2, "workspace-a", "task-b", true))
            .expect("append second");
        let pending = PendingDeleteV1 {
            schema_version: SCHEMA_VERSION,
            next_generation: 1,
            events: vec![PendingDeleteEvent {
                sequence: first.header.sequence,
                had_payload: true,
                payload_bytes: first
                    .header
                    .payload
                    .as_ref()
                    .expect("payload metadata")
                    .byte_length,
            }],
        };
        atomic_write(
            &root.join(DELETE_PENDING_FILE),
            &serialize_json(&pending).expect("serialize pending delete"),
        )
        .expect("write pending delete");
        drop(store);

        let reopened = AgentEventStore::open(root.clone()).expect("resume pending delete");
        assert_eq!(reopened.headers.len(), 1);
        assert_eq!(reopened.headers[0].task_id, "task-b");
        assert_eq!(reopened.manifest.delete_generation, 1);
        assert!(!root.join(DELETE_PENDING_FILE).exists());
        assert!(!root
            .join(PAYLOADS_DIR)
            .join(format!("{}.json", first.header.event_id))
            .exists());
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn disabled_capability_does_not_open_store_and_reenables_existing_data() {
        let base = temp_base("disabled");
        ensure_directory(&base).expect("create base");
        secure_write_new(&base.join(DISABLED_FILE), b"disabled\n").expect("write marker");
        let state = AgentEventStoreState::from_base_dir(base.clone());
        assert_eq!(
            state.status().capability,
            AgentEventStoreCapabilityState::Disabled
        );
        assert!(!base.join("v1").exists());
        {
            let mut inner = state.inner.lock();
            fs::remove_file(&inner.disabled_marker).expect("remove marker");
            inner.mode =
                StoreMode::Ready(AgentEventStore::open(inner.root.clone()).expect("enable store"));
            match &mut inner.mode {
                StoreMode::Ready(store) => {
                    store
                        .append(append_request(1, "workspace-a", "task-a", false))
                        .expect("append after enable");
                }
                _ => panic!("store was not enabled"),
            }
            secure_write_new(&inner.disabled_marker, b"disabled\n").expect("disable marker");
            inner.mode = StoreMode::Disabled;
        }
        let reopened_disabled = AgentEventStoreState::from_base_dir(base.clone());
        assert_eq!(
            reopened_disabled.status().capability,
            AgentEventStoreCapabilityState::Disabled
        );
        fs::remove_file(base.join(DISABLED_FILE)).expect("enable marker");
        let reopened_enabled = AgentEventStoreState::from_base_dir(base.clone());
        assert_eq!(reopened_enabled.status().event_count, Some(1));
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn strict_bounds_and_idempotency_conflicts_are_rejected() {
        let base = temp_base("bounds");
        let mut store = AgentEventStore::open(base.join("v1")).expect("open store");
        let request = append_request(1, "workspace-a", "task-a", false);
        store.append(request.clone()).expect("append initial");
        let mut conflict = request;
        conflict.summary = "different".to_string();
        assert_eq!(
            store.append(conflict).expect_err("conflicting retry").code,
            "idempotencyConflict"
        );
        let mut unsafe_id = append_request(2, "../workspace", "task-a", false);
        assert_eq!(
            store
                .append(unsafe_id.clone())
                .expect_err("path-like workspace")
                .code,
            "invalidField"
        );
        unsafe_id.workspace_id = "workspace-a".to_string();
        unsafe_id.summary = "x".repeat(MAX_SUMMARY_BYTES + 1);
        assert_eq!(
            store.append(unsafe_id).expect_err("oversized summary").code,
            "invalidSummary"
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn supported_local_image_payload_types_round_trip_and_active_content_is_rejected() {
        let base = temp_base("image-content-types");
        let mut store = AgentEventStore::open(base.join("v1")).expect("open store");
        for (index, content_type) in ["image/png", "image/jpeg", "image/webp"].iter().enumerate() {
            let mut request = append_request(index + 1, "workspace-a", "task-a", false);
            request.private_payload = Some(AgentEventPrivatePayloadInput {
                content_type: (*content_type).to_string(),
                body: "strict-base64-fixture".to_string(),
            });
            let appended = store
                .append(request)
                .expect("append supported image payload");
            let payload = store
                .payload(&appended.header.event_id)
                .expect("read image payload");
            assert_eq!(payload.content_type, *content_type);
            assert_eq!(payload.body, "strict-base64-fixture");
        }
        let mut active = append_request(4, "workspace-a", "task-a", false);
        active.private_payload = Some(AgentEventPrivatePayloadInput {
            content_type: "text/html".to_string(),
            body: "<script>alert(1)</script>".to_string(),
        });
        assert_eq!(
            store.append(active).expect_err("reject active HTML").code,
            "unsupportedContentType"
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    #[test]
    fn maximum_private_payload_stays_out_of_header_pages_and_oversize_is_rejected() {
        let base = temp_base("large-payload");
        let mut store = AgentEventStore::open(base.join("v1")).expect("open store");
        let mut at_limit = append_request(1, "workspace-a", "task-a", false);
        at_limit.private_payload = Some(AgentEventPrivatePayloadInput {
            content_type: "text/plain".to_string(),
            body: "x".repeat(MAX_PAYLOAD_BYTES),
        });
        let appended = store.append(at_limit).expect("append maximum payload");
        assert_eq!(
            appended
                .header
                .payload
                .as_ref()
                .expect("payload metadata")
                .byte_length,
            MAX_PAYLOAD_BYTES as u64
        );
        let page = store
            .list(AgentEventListRequest {
                scope: AgentEventQueryScope::All,
                cursor: None,
                limit: Some(1),
            })
            .expect("list header only");
        assert_eq!(page.items.len(), 1);
        assert_eq!(store.payload_reads, 0);

        let mut oversized = append_request(2, "workspace-a", "task-a", false);
        oversized.private_payload = Some(AgentEventPrivatePayloadInput {
            content_type: "text/plain".to_string(),
            body: "x".repeat(MAX_PAYLOAD_BYTES + 1),
        });
        assert_eq!(
            store
                .append(oversized)
                .expect_err("reject oversized payload")
                .code,
            "payloadTooLarge"
        );
        fs::remove_dir_all(base).expect("remove fixture");
    }

    fn directory_bytes(path: &Path) -> u64 {
        let mut total = 0_u64;
        let mut stack = vec![path.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(current).expect("read benchmark dir") {
                let entry = entry.expect("read benchmark entry");
                let metadata = entry.metadata().expect("read benchmark metadata");
                if metadata.is_dir() {
                    stack.push(entry.path());
                } else {
                    total = total.saturating_add(metadata.len());
                }
            }
        }
        total
    }

    #[cfg(target_os = "macos")]
    fn rss_kib() -> u64 {
        let output = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .expect("run ps");
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .expect("parse rss")
    }

    #[test]
    #[ignore = "run explicitly in the optimized macOS M3 harness"]
    #[cfg(target_os = "macos")]
    fn macos_optimized_harness_10000_headers_and_real_pty() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{BufRead, BufReader};
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        let base = temp_base("macos-release-harness");
        let fixture_started = Instant::now();
        let root = write_fixture(&base, 10_000, 250);
        let fixture_ms = fixture_started.elapsed().as_millis();
        let rss_before = rss_kib();
        let open_started = Instant::now();
        let store = AgentEventStore::open(root.clone()).expect("open 10k fixture");
        let restart_ms = open_started.elapsed().as_millis();
        let first_started = Instant::now();
        let first = store
            .list(AgentEventListRequest {
                scope: AgentEventQueryScope::All,
                cursor: None,
                limit: Some(100),
            })
            .expect("first 100 headers");
        let first_page_us = first_started.elapsed().as_micros();
        assert_eq!(first.items.len(), 100);
        let all_started = Instant::now();
        let all = collect_all(&store, AgentEventQueryScope::All);
        let all_pages_ms = all_started.elapsed().as_millis();
        assert_eq!(all.len(), 10_000);
        assert_eq!(all.iter().copied().collect::<HashSet<_>>().len(), 10_000);
        assert_eq!(store.payload_reads, 0);
        let rss_after = rss_kib();

        let store = Arc::new(Mutex::new(store));
        let page_store = store.clone();
        let paging = thread::spawn(move || {
            for _ in 0..20 {
                let guard = page_store.lock();
                let sequences = collect_all(&guard, AgentEventQueryScope::All);
                assert_eq!(sequences.len(), 10_000);
            }
        });

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open real pty");
        let mut child = pair
            .slave
            .spawn_command(CommandBuilder::new("/bin/cat"))
            .expect("spawn cat in pty");
        drop(pair.slave);
        let mut writer = pair.master.take_writer().expect("take pty writer");
        let reader = pair.master.try_clone_reader().expect("clone pty reader");
        let (line_tx, line_rx) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                if line_tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut latencies = Vec::new();
        for index in 0..50 {
            let marker = format!("tunara-m3-pty-{index}");
            let started = Instant::now();
            writeln!(writer, "{marker}").expect("write pty probe");
            writer.flush().expect("flush pty probe");
            loop {
                let line = line_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("pty echo timeout");
                if line.contains(&marker) {
                    break;
                }
            }
            latencies.push(started.elapsed().as_micros() as u64);
        }
        latencies.sort_unstable();
        let p95_us = latencies[(latencies.len() * 95 / 100).min(latencies.len() - 1)];
        drop(writer);
        child.kill().expect("kill pty child");
        let _ = child.wait();
        paging.join().expect("join paging worker");
        drop(line_rx);
        reader_thread.join().expect("join pty reader");

        let rss_delta_kib = rss_after.saturating_sub(rss_before);
        let disk_bytes = directory_bytes(&root);
        println!(
            "m3_harness fixture_ms={fixture_ms} restart_ms={restart_ms} first_page_us={first_page_us} all_pages_ms={all_pages_ms} payload_reads=0 rss_delta_kib={rss_delta_kib} disk_bytes={disk_bytes} pty_p95_us={p95_us} pty_failures=0"
        );
        assert!(first_page_us < 50_000, "first page exceeded 50ms");
        assert!(all_pages_ms < 500, "full pagination exceeded 500ms");
        assert!(rss_delta_kib < 64 * 1024, "RSS delta exceeded 64MiB");
        assert!(p95_us < 50_000, "PTY p95 exceeded 50ms");
        fs::remove_dir_all(base).expect("remove benchmark fixture");
    }
}
