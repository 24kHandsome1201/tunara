use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

const SCHEMA_VERSION: u16 = 1;
const FILE_SIZE_LIMIT: u64 = 2 * 1024 * 1024;
const TOTAL_SIZE_LIMIT: u64 = 20 * 1024 * 1024;
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const FILE_PREFIX: &str = "tunara-usage-";
const FILE_SUFFIX: &str = ".jsonl";

#[derive(Clone, Copy)]
struct Limits {
    file_size: u64,
    total_size: u64,
    retention: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_size: FILE_SIZE_LIMIT,
            total_size: TOTAL_SIZE_LIMIT,
            retention: RETENTION,
        }
    }
}

struct Inner {
    available: bool,
    enabled: bool,
    directory: PathBuf,
    run_id: String,
    id_salt: [u8; 32],
    started_at_ms: u64,
    sequence: u64,
    active_path: Option<PathBuf>,
    limits: Limits,
}

pub struct LocalUsageLogState {
    inner: Mutex<Inner>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogEventRequest {
    pub event: String,
    pub session_id: Option<String>,
    pub correlation_id: Option<String>,
    pub duration_ms: Option<u64>,
    pub success: Option<bool>,
    pub outcome: Option<String>,
    pub error_category: Option<String>,
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
struct UsageLogEvent {
    schema_version: u16,
    app_version: &'static str,
    timestamp_ms: u64,
    app_run_id: String,
    event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_category: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    attributes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogStatus {
    pub enabled: bool,
    pub directory: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub retention_days: u64,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
}

impl LocalUsageLogState {
    pub fn new(directory: PathBuf, enabled: bool) -> Result<Self, String> {
        Self::new_with_limits(directory, enabled, Limits::default())
    }

    fn new_with_limits(directory: PathBuf, enabled: bool, limits: Limits) -> Result<Self, String> {
        let mut random = [0_u8; 48];
        getrandom::fill(&mut random)
            .map_err(|error| format!("local usage log randomness unavailable: {error}"))?;
        let started_at_ms = now_ms();
        let state = Self {
            inner: Mutex::new(Inner {
                available: true,
                enabled,
                directory,
                run_id: hex(&random[..16]),
                id_salt: random[16..].try_into().expect("32-byte usage-log salt"),
                started_at_ms,
                sequence: 0,
                active_path: None,
                limits,
            }),
        };
        Ok(state)
    }

    /// Fail-closed state used only when the platform log path or secure random
    /// source is unavailable. Keeping this state managed lets the app continue
    /// to run while Settings reports logging as disabled and enable attempts
    /// return a normal, user-visible error.
    pub fn unavailable() -> Self {
        Self {
            inner: Mutex::new(Inner {
                available: false,
                enabled: false,
                directory: PathBuf::new(),
                run_id: String::new(),
                id_salt: [0; 32],
                started_at_ms: now_ms(),
                sequence: 0,
                active_path: None,
                limits: Limits::default(),
            }),
        }
    }

    pub fn record_startup(&self) {
        let request = UsageLogEventRequest {
            event: "app.started".into(),
            success: Some(true),
            ..UsageLogEventRequest::default()
        };
        if let Err(error) = self.record(request) {
            log::warn!("local usage log startup event was not written: {error}");
        }
    }

    fn record(&self, request: UsageLogEventRequest) -> Result<(), String> {
        let mut inner = self.inner.lock();
        if !inner.enabled {
            return Ok(());
        }
        let event = sanitize_event(&inner, request)?;
        write_event_locked(&mut inner, &event)
    }

    fn set_enabled(&self, enabled: bool) -> Result<UsageLogStatus, String> {
        let mut inner = self.inner.lock();
        if !inner.available {
            if enabled {
                return Err("local usage logging is unavailable on this platform".into());
            }
            return status_locked(&inner);
        }
        if inner.enabled == enabled {
            return status_locked(&inner);
        }
        if !enabled {
            inner.enabled = false;
            inner.active_path = None;
            return status_locked(&inner);
        }
        ensure_private_directory(&inner.directory)?;
        cleanup_locked(&mut inner)?;
        inner.enabled = true;
        let event = sanitize_event(
            &inner,
            UsageLogEventRequest {
                event: "settings.local_usage_logging_enabled".into(),
                success: Some(true),
                ..UsageLogEventRequest::default()
            },
        )?;
        write_event_locked(&mut inner, &event)?;
        status_locked(&inner)
    }

    fn ensure_directory(&self) -> Result<String, String> {
        let inner = self.inner.lock();
        if !inner.available {
            return Err("the local usage log directory is unavailable on this platform".into());
        }
        ensure_private_directory(&inner.directory)?;
        Ok(inner.directory.to_string_lossy().into_owned())
    }

    fn status(&self) -> Result<UsageLogStatus, String> {
        status_locked(&self.inner.lock())
    }

    fn clear(&self) -> Result<UsageLogStatus, String> {
        let mut inner = self.inner.lock();
        if !inner.available {
            return status_locked(&inner);
        }
        if inner.directory.exists() {
            for entry in log_files(&inner.directory)? {
                fs::remove_file(&entry.path)
                    .map_err(|error| format!("clear local usage log failed: {error}"))?;
            }
        }
        inner.active_path = None;
        inner.sequence = inner.sequence.saturating_add(1);
        status_locked(&inner)
    }

    fn export(&self, destination: &Path) -> Result<u64, String> {
        let inner = self.inner.lock();
        if !inner.available {
            return Err("local usage logging is unavailable on this platform".into());
        }
        let files = log_files(&inner.directory)?;
        if files.is_empty() {
            return Err("no local usage logs are available to export".into());
        }
        if files.iter().any(|file| file.path == destination) {
            return Err("export destination cannot replace an active usage log".into());
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "export destination has no parent directory".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("create export directory failed: {error}"))?;
        let temporary =
            destination.with_extension(format!("jsonl.{}.{}.tmp", std::process::id(), now_ms()));
        let result = export_complete_json_lines(&files, &temporary);
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        if destination.exists() {
            fs::remove_file(destination)
                .map_err(|error| format!("replace exported usage log failed: {error}"))?;
        }
        fs::rename(&temporary, destination)
            .map_err(|error| format!("finish usage log export failed: {error}"))?;
        fs::metadata(destination)
            .map(|metadata| metadata.len())
            .map_err(|error| format!("inspect usage log export failed: {error}"))
    }
}

#[tauri::command]
pub fn local_usage_log_record(state: State<'_, LocalUsageLogState>, request: UsageLogEventRequest) {
    // Event logging is best-effort by contract: validation, disk, rotation, and
    // permission failures must never alter an SSH or terminal workflow.
    if let Err(error) = state.record(request) {
        log::warn!("local usage log event was not written: {error}");
    }
}

#[tauri::command]
pub fn local_usage_log_set_enabled(
    state: State<'_, LocalUsageLogState>,
    enabled: bool,
) -> Result<UsageLogStatus, String> {
    state.set_enabled(enabled)
}

#[tauri::command]
pub fn local_usage_log_status(
    state: State<'_, LocalUsageLogState>,
) -> Result<UsageLogStatus, String> {
    state.status()
}

#[tauri::command]
pub fn local_usage_log_ensure_directory(
    state: State<'_, LocalUsageLogState>,
) -> Result<String, String> {
    state.ensure_directory()
}

#[tauri::command]
pub fn local_usage_log_clear(
    state: State<'_, LocalUsageLogState>,
) -> Result<UsageLogStatus, String> {
    state.clear()
}

#[tauri::command]
pub fn local_usage_log_export(
    state: State<'_, LocalUsageLogState>,
    destination: String,
) -> Result<u64, String> {
    state.export(Path::new(&destination))
}

fn sanitize_event(inner: &Inner, request: UsageLogEventRequest) -> Result<UsageLogEvent, String> {
    if !allowed_event(&request.event) {
        return Err("unsupported local usage log event".into());
    }
    if request
        .attributes
        .iter()
        .any(|(key, value)| !allowed_attribute(key, value))
    {
        return Err("unsupported local usage log attribute".into());
    }
    Ok(UsageLogEvent {
        schema_version: SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION"),
        timestamp_ms: now_ms(),
        app_run_id: inner.run_id.clone(),
        event: request.event,
        session_id: request
            .session_id
            .filter(|value| !value.is_empty())
            .map(|value| anonymous_id(&inner.id_salt, "session", &value)),
        correlation_id: request
            .correlation_id
            .filter(|value| !value.is_empty())
            .map(|value| anonymous_id(&inner.id_salt, "correlation", &value)),
        duration_ms: request
            .duration_ms
            .map(|value| value.min(24 * 60 * 60 * 1000)),
        success: request.success,
        outcome: request.outcome.filter(|value| allowed_outcome(value)),
        error_category: request.error_category.map(|value| {
            if allowed_error_category(&value) {
                value
            } else {
                "unknown".into()
            }
        }),
        attributes: request.attributes,
    })
}

fn allowed_event(event: &str) -> bool {
    matches!(
        event,
        "app.started"
            | "settings.local_usage_logging_enabled"
            | "ssh.session.created"
            | "ssh.session.open_requested"
            | "ssh.session.opened"
            | "ssh.session.open_failed"
            | "ssh.session.closed"
            | "ssh.connection.phase"
            | "ssh.host_key.prompted"
            | "ssh.host_key.decided"
            | "ssh.host_key.persistence"
            | "ssh.reconnect.scheduled"
            | "ssh.reconnect.started"
            | "ssh.reconnect.completed"
            | "ssh.reconnect.failed"
            | "ssh.disconnected"
            | "ssh.terminal.command_started"
            | "ssh.terminal.command_finished"
            | "ssh.files.operation"
            | "ssh.transfer.queued"
            | "ssh.transfer.finished"
            | "ssh.transfer.cancelled"
            | "ssh.transfer.retry"
            | "ssh.transfer.recovery"
            | "ssh.preview.action"
    )
}

fn allowed_outcome(value: &str) -> bool {
    matches!(
        value,
        "started"
            | "completed"
            | "failed"
            | "cancelled"
            | "scheduled"
            | "needs_user_action"
            | "outcome_unknown"
            | "skipped"
            | "accepted"
            | "rejected"
            | "saved"
            | "session_only"
            | "durability_unknown"
    )
}

fn allowed_error_category(value: &str) -> bool {
    matches!(
        value,
        "auth"
            | "host_key"
            | "connect"
            | "timeout"
            | "cancelled"
            | "disconnected"
            | "stale_binding"
            | "io"
            | "permission"
            | "conflict"
            | "unsupported"
            | "internal"
            | "unknown"
    )
}

fn allowed_attribute(key: &str, value: &str) -> bool {
    match key {
        "transport" => matches!(value, "local" | "ssh"),
        "phase" => matches!(
            value,
            "pending"
                | "opening"
                | "connecting"
                | "verifying_host_key"
                | "handshaking"
                | "authenticating"
                | "opening_shell"
                | "reconnecting"
                | "needs_user_action"
                | "ready"
                | "disconnected"
                | "failed"
                | "exited"
        ),
        "auth_method" | "jump_auth_method" => matches!(
            value,
            "agent" | "key" | "password" | "keyboard_interactive" | "unknown"
        ),
        "route" => matches!(value, "direct" | "jump"),
        "hop_role" => matches!(value, "direct" | "jump" | "target"),
        "reason" => matches!(
            value,
            "unknown"
                | "unverifiable"
                | "user"
                | "restore"
                | "backend"
                | "renderer"
                | "transport"
                | "host_key"
                | "automatic"
        ),
        "operation" => matches!(
            value,
            "home"
                | "read_directory"
                | "read_file"
                | "write_file"
                | "reconcile_write"
                | "search"
                | "grep"
                | "upload"
                | "download"
                | "cancel"
                | "retry"
                | "reconcile"
                | "delete_partial"
                | "restart"
                | "dismiss"
                | "open"
                | "refresh"
                | "close"
                | "navigate"
                | "tunnel_open"
                | "tunnel_close"
                | "capture"
                | "send_capture"
                | "zoom"
                | "viewport"
        ),
        "direction" => matches!(value, "upload" | "download"),
        "exit_status" => matches!(value, "zero" | "nonzero" | "disconnected"),
        "size_bucket" => matches!(
            value,
            "unknown" | "empty" | "under_1m" | "under_10m" | "under_100m" | "over_100m"
        ),
        "attempt" => value
            .parse::<u16>()
            .is_ok_and(|attempt| (1..=100).contains(&attempt)),
        _ => false,
    }
}

fn write_event_locked(inner: &mut Inner, event: &UsageLogEvent) -> Result<(), String> {
    ensure_private_directory(&inner.directory)?;
    cleanup_locked(inner)?;
    let mut line = serde_json::to_vec(event)
        .map_err(|error| format!("serialize local usage log event failed: {error}"))?;
    line.push(b'\n');
    let rotate = inner.active_path.as_ref().is_none_or(|path| {
        fs::metadata(path)
            .map(|metadata| {
                metadata.len().saturating_add(line.len() as u64) > inner.limits.file_size
            })
            .unwrap_or(true)
    });
    if rotate {
        inner.sequence = inner.sequence.saturating_add(1);
        inner.active_path = Some(inner.directory.join(format!(
            "{FILE_PREFIX}{}-{}-{:04}{FILE_SUFFIX}",
            inner.started_at_ms, inner.run_id, inner.sequence
        )));
    }
    let path = inner.active_path.as_ref().expect("active usage log path");
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("open local usage log failed: {error}"))?;
    if let Err(error) = file.write_all(&line) {
        inner.active_path = None;
        return Err(format!("write local usage log failed: {error}"));
    }
    if let Err(error) = file.flush() {
        inner.active_path = None;
        return Err(format!("flush local usage log failed: {error}"));
    }
    enforce_total_size_locked(inner)
}

struct LogFile {
    path: PathBuf,
    modified: SystemTime,
    size: u64,
}

fn log_files(directory: &Path) -> Result<Vec<LogFile>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("read local usage log directory failed: {error}"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("read local usage log entry failed: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect local usage log entry failed: {error}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_managed_log_name(&name) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("inspect local usage log file failed: {error}"))?;
        files.push(LogFile {
            path: entry.path(),
            modified: metadata.modified().unwrap_or(UNIX_EPOCH),
            size: metadata.len(),
        });
    }
    files.sort_by_key(|file| file.modified);
    Ok(files)
}

fn is_managed_log_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix(FILE_PREFIX)
        .and_then(|value| value.strip_suffix(FILE_SUFFIX))
    else {
        return false;
    };
    let mut parts = stem.split('-');
    let (Some(started_at), Some(run_id), Some(sequence)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    parts.next().is_none()
        && !started_at.is_empty()
        && started_at.bytes().all(|byte| byte.is_ascii_digit())
        && run_id.len() == 32
        && run_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        && sequence.len() >= 4
        && sequence.bytes().all(|byte| byte.is_ascii_digit())
}

fn cleanup_locked(inner: &mut Inner) -> Result<(), String> {
    let cutoff = SystemTime::now()
        .checked_sub(inner.limits.retention)
        .unwrap_or(UNIX_EPOCH);
    for file in log_files(&inner.directory)? {
        if file.modified < cutoff && inner.active_path.as_ref() != Some(&file.path) {
            fs::remove_file(file.path)
                .map_err(|error| format!("expire local usage log failed: {error}"))?;
        }
    }
    enforce_total_size_locked(inner)
}

fn enforce_total_size_locked(inner: &mut Inner) -> Result<(), String> {
    let files = log_files(&inner.directory)?;
    let mut total = files.iter().map(|file| file.size).sum::<u64>();
    for file in files {
        if total <= inner.limits.total_size {
            break;
        }
        if inner.active_path.as_ref() == Some(&file.path) {
            continue;
        }
        fs::remove_file(&file.path)
            .map_err(|error| format!("rotate local usage log failed: {error}"))?;
        total = total.saturating_sub(file.size);
    }
    Ok(())
}

fn status_locked(inner: &Inner) -> Result<UsageLogStatus, String> {
    if !inner.available {
        return Ok(UsageLogStatus {
            enabled: false,
            directory: String::new(),
            file_count: 0,
            total_bytes: 0,
            retention_days: inner.limits.retention.as_secs() / (24 * 60 * 60),
            max_total_bytes: inner.limits.total_size,
            max_file_bytes: inner.limits.file_size,
        });
    }
    let files = log_files(&inner.directory)?;
    Ok(UsageLogStatus {
        enabled: inner.enabled,
        directory: inner.directory.to_string_lossy().into_owned(),
        file_count: files.len(),
        total_bytes: files.iter().map(|file| file.size).sum(),
        retention_days: inner.limits.retention.as_secs() / (24 * 60 * 60),
        max_total_bytes: inner.limits.total_size,
        max_file_bytes: inner.limits.file_size,
    })
}

fn export_complete_json_lines(files: &[LogFile], destination: &Path) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(destination)
        .map_err(|error| format!("create usage log export failed: {error}"))?;
    for file in files {
        let mut content = Vec::new();
        fs::File::open(&file.path)
            .and_then(|mut input| input.read_to_end(&mut content))
            .map_err(|error| format!("read usage log for export failed: {error}"))?;
        for line in content.split_inclusive(|byte| *byte == b'\n') {
            if !line.ends_with(b"\n") {
                continue;
            }
            let json = &line[..line.len() - 1];
            if json.is_empty() || serde_json::from_slice::<serde_json::Value>(json).is_err() {
                continue;
            }
            output
                .write_all(json)
                .and_then(|_| output.write_all(b"\n"))
                .map_err(|error| format!("write usage log export failed: {error}"))?;
        }
    }
    output
        .sync_all()
        .map_err(|error| format!("sync usage log export failed: {error}"))
}

fn ensure_private_directory(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("create local usage log directory failed: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure local usage log directory failed: {error}"))?;
    }
    Ok(())
}

fn anonymous_id(salt: &[u8; 32], domain: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt);
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    format!("anon_{}", hex(&digest[..12]))
}

fn hex(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("tunara-usage-log-{name}-{unique}"))
    }

    fn request(event: &str, session_id: &str) -> UsageLogEventRequest {
        UsageLogEventRequest {
            event: event.into(),
            session_id: Some(session_id.into()),
            success: Some(true),
            ..UsageLogEventRequest::default()
        }
    }

    fn read_all(directory: &Path) -> String {
        log_files(directory)
            .expect("list usage logs")
            .into_iter()
            .map(|file| fs::read_to_string(file.path).expect("read usage log"))
            .collect()
    }

    #[test]
    fn disabled_by_default_and_stops_immediately_after_disable() {
        let directory = temp_directory("disabled");
        let state = LocalUsageLogState::new(directory.clone(), false).expect("create state");
        state
            .record(request("ssh.session.created", "session-secret"))
            .expect("disabled record is a no-op");
        assert!(!directory.exists());

        state.set_enabled(true).expect("enable logging");
        state
            .record(request("ssh.session.created", "session-secret"))
            .expect("write enabled event");
        let before = read_all(&directory);
        assert!(!before.is_empty());
        state.set_enabled(false).expect("disable logging");
        state
            .record(request("ssh.session.closed", "session-secret"))
            .expect("disabled record is a no-op");
        assert_eq!(read_all(&directory), before);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn identifiers_are_correlated_but_raw_sensitive_fields_never_reach_disk() {
        let directory = temp_directory("sanitized");
        let state = LocalUsageLogState::new(directory.clone(), true).expect("create state");
        let mut attributes = BTreeMap::new();
        attributes.insert("auth_method".into(), "password".into());
        attributes.insert("operation".into(), "read_file".into());
        let event = UsageLogEventRequest {
            event: "ssh.files.operation".into(),
            session_id: Some("user@prod.example.com".into()),
            correlation_id: Some("/home/alice/secrets.txt".into()),
            outcome: Some("completed".into()),
            error_category: Some("credential_value".into()),
            attributes,
            ..UsageLogEventRequest::default()
        };
        state.record(event).expect("write sanitized event");
        let mut correlated = request("ssh.session.closed", "user@prod.example.com");
        correlated.correlation_id = Some("/home/alice/secrets.txt".into());
        state.record(correlated).expect("write correlated event");

        let before_rejected = read_all(&directory);
        let mut rejected = request("ssh.files.operation", "user@prod.example.com");
        rejected
            .attributes
            .insert("path".into(), "/home/alice/.ssh/id_ed25519".into());
        assert_eq!(
            state
                .record(rejected)
                .expect_err("reject unknown attribute"),
            "unsupported local usage log attribute"
        );
        assert_eq!(read_all(&directory), before_rejected);

        let body = read_all(&directory);
        for secret in [
            "prod.example.com",
            "/home/alice",
            "secrets.txt",
            "sensitive-marker",
            "credential_value",
        ] {
            assert!(!body.contains(secret), "sensitive value leaked: {secret}");
        }
        assert!(body.contains("\"auth_method\":\"password\""));
        assert!(body.contains("\"operation\":\"read_file\""));
        assert!(body.contains("\"error_category\":\"unknown\""));
        let session_ids: Vec<String> = body
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|value| value["session_id"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(session_ids.len(), 2);
        assert_eq!(session_ids[0], session_ids[1]);
        assert!(session_ids[0].starts_with("anon_"));
        let correlation_ids: Vec<String> = body
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|value| value["correlation_id"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(correlation_ids.len(), 2);
        assert_eq!(correlation_ids[0], correlation_ids[1]);
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn unknown_events_are_rejected_before_any_file_is_created() {
        let directory = temp_directory("unknown-event");
        let state = LocalUsageLogState::new(directory.clone(), true).expect("create state");
        let error = state
            .record(request("ssh.raw_terminal_output", "session-1"))
            .expect_err("reject unknown event");
        assert_eq!(error, "unsupported local usage log event");
        assert!(!directory.exists());
    }

    #[test]
    fn unavailable_state_is_fail_closed_without_affecting_the_app() {
        let state = LocalUsageLogState::unavailable();
        state
            .record(request("ssh.session.created", "session-1"))
            .expect("disabled unavailable state is a no-op");
        let status = state.status().expect("read unavailable status");
        assert!(!status.enabled);
        assert!(status.directory.is_empty());
        assert!(state.set_enabled(true).is_err());
    }

    #[test]
    fn rotates_enforces_capacity_and_clear_removes_every_log() {
        let directory = temp_directory("rotation");
        let state = LocalUsageLogState::new_with_limits(
            directory.clone(),
            true,
            Limits {
                file_size: 300,
                total_size: 750,
                retention: Duration::from_secs(3600),
            },
        )
        .expect("create state");
        for index in 0..20 {
            let mut event = request("ssh.connection.phase", "session-1");
            event.correlation_id = Some(format!("attempt-{index}"));
            event.attributes.insert("phase".into(), "connecting".into());
            state.record(event).expect("write rotating event");
        }
        let status = state.status().expect("read status");
        assert!(status.file_count >= 2);
        assert!(status.total_bytes <= 750);
        let unrelated = directory.join("tunara-usage-logs.jsonl");
        fs::write(&unrelated, "manual export").expect("write unrelated JSONL");
        let cleared = state.clear().expect("clear logs");
        assert_eq!(cleared.file_count, 0);
        assert_eq!(cleared.total_bytes, 0);
        assert_eq!(
            fs::read_to_string(unrelated).expect("read unrelated JSONL"),
            "manual export"
        );
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn export_skips_a_crash_truncated_tail_and_stays_valid_jsonl() {
        let directory = temp_directory("export");
        let state = LocalUsageLogState::new(directory.clone(), true).expect("create state");
        state
            .record(request("ssh.session.created", "session-1"))
            .expect("write event");
        let active = state.inner.lock().active_path.clone().expect("active path");
        OpenOptions::new()
            .append(true)
            .open(active)
            .and_then(|mut file| file.write_all(b"{\"incomplete\":"))
            .expect("append truncated event");
        let destination = directory.with_extension("export.jsonl");
        state.export(&destination).expect("export logs");
        let exported = fs::read_to_string(&destination).expect("read export");
        assert!(!exported.contains("incomplete"));
        assert!(exported
            .lines()
            .all(|line| serde_json::from_str::<serde_json::Value>(line).is_ok()));
        fs::remove_file(destination).expect("remove export");
        fs::remove_dir_all(directory).expect("remove fixture");
    }

    #[test]
    fn retention_cleanup_expires_rotated_files() {
        let directory = temp_directory("retention");
        let state = LocalUsageLogState::new_with_limits(
            directory.clone(),
            true,
            Limits {
                file_size: 1,
                total_size: 10_000,
                retention: Duration::ZERO,
            },
        )
        .expect("create state");
        for index in 0..4 {
            let mut event = request("ssh.connection.phase", "session-1");
            event.correlation_id = Some(format!("attempt-{index}"));
            state.record(event).expect("write retained event");
        }
        let status = state.status().expect("read retained status");
        assert!(status.file_count <= 2, "expired rotated files remained");
        fs::remove_dir_all(directory).expect("remove fixture");
    }
}
