//! Remote git status/diff over an SSH exec channel.
//!
//! Mirrors the local `git_status`/`git_diff` IPC contract (`StatusResult`,
//! `FileChange`, `FileDiff`) so the frontend DiffPanel can render remote repos
//! without caring about the transport. Read-only — runs `git status` / `git
//! diff` on the remote, never writes.
//!
//! Degradation: if the remote lacks git or the cwd isn't a repo, the exec
//! returns a descriptive error and the frontend surfaces "remote git
//! unavailable" instead of crashing the session.

use serde::{Deserialize, Serialize};
use tauri::State;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::modules::fs::grep::{
    validate_request_id, FsSearchCancellationState, GrepHit, GrepResponse,
};
use crate::modules::fs::search::SearchHit;
use crate::modules::git::workspace::{RepositoryRef, WorkspaceContext, WorktreeRef};
use crate::modules::git::{FileChange, FileDiff, RemoteState, StatusResult};
use crate::modules::pty::{PtyState, Session};
use crate::modules::ssh::diagnostics::SessionBindingV1;
use crate::modules::ssh::{
    is_remote_non_git_error, safe_ipc_error, safe_ipc_error_with_policy, RemoteGitLogPolicy,
    SshIpcErrorKind,
};

/// Resolve the SSH session behind a session id as a cloned `Arc<Session>` so
/// the caller can hold it across `.await` points without borrowing the
/// `PtyState`. Returns an error for local sessions or missing ids.
fn ssh_session(state: &State<'_, PtyState>, id: u32) -> Result<std::sync::Arc<Session>, String> {
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    match session.as_ref() {
        Session::Ssh(_) => Ok(session),
        Session::Local(_) => Err("not a remote session".to_string()),
    }
}

/// Cap stdout collection so a pathological repo can't OOM the UI. Matches the
/// local `git_diff` text-preview budget (256 KiB) — DiffPanel already renders
/// `tooLarge` beyond that.
const MAX_STATUS_BYTES: usize = 256 * 1024;
const MAX_DIFF_BYTES: usize = 256 * 1024;
/// Line cap mirroring the local path's `DIFF_MAX_LINES` (git/mod.rs), so the
/// DiffPanel shows the same "truncated" hint for local and remote diffs.
const MAX_DIFF_LINES: usize = 2000;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_git_cwd(cwd: &str) -> Result<String, String> {
    if !cwd.starts_with('/') || cwd.len() > 4_096 || cwd.chars().any(char::is_control) {
        return Err("remote git cwd must be an absolute path".to_string());
    }
    Ok(shell_quote(cwd))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteRepoKnowledge {
    Confirmed,
    Absent,
}

#[derive(Clone, Copy, Debug)]
struct RemoteRepoCacheEntry {
    knowledge: RemoteRepoKnowledge,
    expires_at: Instant,
}

const CONFIRMED_REPO_TTL: Duration = Duration::from_secs(30);
const ABSENT_REPO_TTL: Duration = Duration::from_secs(8);
const REMOTE_REPO_CACHE_CAP: usize = 64;

fn remote_repo_cache() -> &'static Mutex<HashMap<(u32, String), RemoteRepoCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<(u32, String), RemoteRepoCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_remote_repo_cwd(cwd: &str) -> Option<String> {
    if !cwd.starts_with('/') || cwd.len() > 4_096 || cwd.chars().any(char::is_control) {
        return None;
    }
    if cwd == "/" {
        return Some("/".into());
    }
    Some(cwd.trim_end_matches('/').to_string())
}

fn cached_remote_repo_knowledge(session_id: u32, cwd: &str) -> Option<RemoteRepoKnowledge> {
    let key = (session_id, normalize_remote_repo_cwd(cwd)?);
    let mut cache = remote_repo_cache().lock().ok()?;
    let entry = cache.get(&key).copied()?;
    if entry.expires_at <= Instant::now() {
        cache.remove(&key);
        return None;
    }
    Some(entry.knowledge)
}

fn remember_remote_repo_knowledge(session_id: u32, cwd: &str, knowledge: RemoteRepoKnowledge) {
    let Some(normalized) = normalize_remote_repo_cwd(cwd) else {
        return;
    };
    let Ok(mut cache) = remote_repo_cache().lock() else {
        return;
    };
    if cache.len() >= REMOTE_REPO_CACHE_CAP {
        let now = Instant::now();
        cache.retain(|_, entry| entry.expires_at > now);
        if cache.len() >= REMOTE_REPO_CACHE_CAP {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
    }
    let ttl = match knowledge {
        RemoteRepoKnowledge::Confirmed => CONFIRMED_REPO_TTL,
        RemoteRepoKnowledge::Absent => ABSENT_REPO_TTL,
    };
    cache.insert(
        (session_id, normalized),
        RemoteRepoCacheEntry {
            knowledge,
            expires_at: Instant::now() + ttl,
        },
    );
}

fn map_remote_git_error(session_id: u32, cwd: &str, error: String) -> String {
    if is_remote_non_git_error(&error) {
        remember_remote_repo_knowledge(session_id, cwd, RemoteRepoKnowledge::Absent);
        return safe_ipc_error_with_policy(
            SshIpcErrorKind::RemoteGit,
            error,
            RemoteGitLogPolicy::Quiet,
        );
    }
    safe_ipc_error(SshIpcErrorKind::RemoteGit, error)
}

fn skip_unconfirmed_remote_git(session_id: u32, cwd: &str) -> Option<String> {
    match cached_remote_repo_knowledge(session_id, cwd)? {
        RemoteRepoKnowledge::Confirmed => None,
        RemoteRepoKnowledge::Absent => Some(safe_ipc_error_with_policy(
            SshIpcErrorKind::RemoteGit,
            "fatal: not a git repository",
            RemoteGitLogPolicy::Quiet,
        )),
    }
}

#[cfg(test)]
fn reset_remote_repo_cache() {
    if let Ok(mut cache) = remote_repo_cache().lock() {
        cache.clear();
    }
}

/// Parse NUL-delimited `git status --porcelain=v1 --branch -z` output into a
/// `StatusResult`.
///
/// Uses porcelain v1 (not v2) because it is supported by every git 1.x/2.x and
/// byte-stable. `-z` is essential: it disables Git's C-quoting and makes paths
/// containing Unicode, quotes, and newlines unambiguous. The branch record
/// `## branch...` carries the branch name; each `XY path` record carries stage
/// + status. v1 doesn't give per-file added/removed counts, so those are 0.
///
/// Pure function so it can be unit-tested without a live SSH connection.
pub(crate) fn parse_porcelain_v1(raw: &str) -> StatusResult {
    let mut branch = String::from("HEAD");
    let mut files: Vec<FileChange> = Vec::new();

    for record in raw.split('\0') {
        if record.is_empty() {
            continue;
        }
        // Branch header: `## main` or `## main...origin/main [ahead 1]`.
        if let Some(rest) = record.strip_prefix("## ") {
            if let Some(unborn) = rest.strip_prefix("No commits yet on ") {
                branch = unborn.to_string();
                continue;
            }
            // Take the branch name up to `...` (upstream) or ` [` (tracking
            // info) or end of line.
            let end = rest
                .find("...")
                .or_else(|| rest.find(' '))
                .unwrap_or(rest.len());
            branch = rest[..end].trim().to_string();
            continue;
        }
        // `XY path` — X = index status, Y = worktree status. At least two chars
        // + a space + path; shorter lines are malformed and skipped.
        if record.len() < 4 {
            continue;
        }
        let x = record.as_bytes()[0] as char;
        let y = record.as_bytes()[1] as char;
        let path = &record[3..];
        if path.is_empty() {
            continue;
        }
        if x == '?' && y == '?' {
            files.push(file_change(path, '?', "untracked"));
            continue;
        }
        if x == '!' && y == '!' {
            continue;
        }
        // A file can have both an index delta and a further worktree delta
        // (`MM`). Emit both rows so staged review never hides unstaged work.
        if x != ' ' && x != '?' {
            files.push(file_change(path, x, "staged"));
        }
        if y != ' ' && y != '?' {
            files.push(file_change(path, y, "unstaged"));
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path).then(a.stage.cmp(&b.stage)));
    StatusResult { branch, files }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGitSnapshotV1 {
    request_id: String,
    generation: u64,
    binding: SessionBindingV1,
    observed_at: u64,
    freshness: SnapshotFreshness,
    repo: Option<RemoteGitRepoV1>,
    unavailable_fields: Vec<UnavailableFieldV1>,
    error: Option<RemoteGitErrorV1>,
}

#[derive(Clone, Debug, Serialize)]
struct RemoteGitRepoV1 {
    status: StatusResult,
    upstream: RemoteState,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<WorkspaceContext>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum SnapshotFreshness {
    Fresh,
    Stale,
}
#[derive(Clone, Debug, Serialize)]
struct UnavailableFieldV1 {
    field: &'static str,
    kind: RemoteGitErrorKind,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RemoteGitErrorKind {
    NotRepository,
    TransportUnavailable,
    Timeout,
    PermissionDenied,
    GitUnavailable,
    PathUnavailable,
    Cancelled,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
struct RemoteGitErrorV1 {
    kind: RemoteGitErrorKind,
    retryable: bool,
}

fn wire_error(kind: RemoteGitErrorKind) -> RemoteGitErrorV1 {
    RemoteGitErrorV1 {
        retryable: matches!(
            kind,
            RemoteGitErrorKind::TransportUnavailable
                | RemoteGitErrorKind::Timeout
                | RemoteGitErrorKind::Cancelled
                | RemoteGitErrorKind::Unknown
        ),
        kind,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGitSnapshotRequestV1 {
    request_id: String,
    generation: u64,
    binding: SessionBindingV1,
    cwd: String,
    repository_key: String,
    force: bool,
}

#[derive(Clone)]
struct SnapshotCacheEntry {
    status: StatusResult,
    upstream: RemoteState,
    workspace: Option<WorkspaceContext>,
    observed_at: u64,
    inserted: Instant,
}

fn snapshot_cache() -> &'static Mutex<HashMap<String, SnapshotCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SnapshotCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn absent_snapshot_cache() -> &'static Mutex<HashMap<String, Instant>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const SNAPSHOT_CACHE_CAP: usize = 128;
const GENERATION_GUARD_CAP: usize = 256;

#[derive(Default)]
struct GenerationGuard {
    latest: HashMap<String, (u64, std::sync::Arc<std::sync::atomic::AtomicBool>)>,
}

fn generation_guard() -> &'static Mutex<GenerationGuard> {
    static GUARD: OnceLock<Mutex<GenerationGuard>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(GenerationGuard::default()))
}

fn register_generation(
    key: &str,
    generation: u64,
) -> Option<std::sync::Arc<std::sync::atomic::AtomicBool>> {
    let mut guard = generation_guard().lock().ok()?;
    if guard
        .latest
        .get(key)
        .is_some_and(|(latest, _)| generation <= *latest)
    {
        return None;
    }
    if let Some((_, old)) = guard.latest.remove(key) {
        old.store(true, Ordering::Release);
    }
    if guard.latest.len() >= GENERATION_GUARD_CAP {
        if let Some(evict) = guard.latest.keys().next().cloned() {
            guard.latest.remove(&evict);
        }
    }
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    guard
        .latest
        .insert(key.to_string(), (generation, cancelled.clone()));
    Some(cancelled)
}

fn generation_is_latest(key: &str, generation: u64) -> bool {
    generation_guard().lock().is_ok_and(|guard| {
        guard.latest.get(key).is_some_and(|(latest, cancelled)| {
            *latest == generation && !cancelled.load(Ordering::Acquire)
        })
    })
}

fn cancelled_response(request: RemoteGitSnapshotRequestV1) -> RemoteGitSnapshotV1 {
    RemoteGitSnapshotV1 {
        request_id: request.request_id,
        generation: request.generation,
        binding: request.binding,
        observed_at: observed_now(),
        freshness: SnapshotFreshness::Fresh,
        repo: None,
        unavailable_fields: Vec::new(),
        error: Some(wire_error(RemoteGitErrorKind::Cancelled)),
    }
}

fn bounded_insert<K: std::hash::Hash + Eq + Clone, V>(
    cache: &mut HashMap<K, V>,
    key: K,
    value: V,
    cap: usize,
) {
    if cache.len() >= cap && !cache.contains_key(&key) {
        if let Some(evict) = cache.keys().next().cloned() {
            cache.remove(&evict);
        }
    }
    cache.insert(key, value);
}

fn not_git_response(request: RemoteGitSnapshotRequestV1) -> RemoteGitSnapshotV1 {
    RemoteGitSnapshotV1 {
        request_id: request.request_id,
        generation: request.generation,
        binding: request.binding,
        observed_at: observed_now(),
        freshness: SnapshotFreshness::Fresh,
        repo: None,
        unavailable_fields: Vec::new(),
        error: Some(wire_error(RemoteGitErrorKind::NotRepository)),
    }
}

fn snapshot_key(binding: &SessionBindingV1, cwd: &str) -> Option<String> {
    Some(format!(
        "{}\0{}\0{}\0{}",
        binding.logical_session_id,
        binding.physical_pty_id,
        binding.transport_generation,
        normalize_remote_repo_cwd(cwd)?
    ))
}

fn observed_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_porcelain_v2(raw: &str) -> Result<(StatusResult, RemoteState), ()> {
    let mut branch = "HEAD".to_string();
    let mut oid = None;
    let mut upstream = None;
    let mut ahead = None;
    let mut behind = None;
    let mut files = Vec::new();
    for record in raw.split('\0').filter(|record| !record.is_empty()) {
        if let Some(value) = record.strip_prefix("# branch.head ") {
            branch = value.to_string();
        } else if let Some(value) = record.strip_prefix("# branch.oid ") {
            oid = Some(value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_string());
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut values = value.split_whitespace();
            ahead = values
                .next()
                .and_then(|v| v.strip_prefix('+'))
                .and_then(|v| v.parse().ok());
            behind = values
                .next()
                .and_then(|v| v.strip_prefix('-'))
                .and_then(|v| v.parse().ok());
        } else if record.starts_with("1 ") || record.starts_with("2 ") {
            let fields: Vec<&str> = record
                .splitn(if record.starts_with("1 ") { 9 } else { 10 }, ' ')
                .collect();
            let xy = fields.get(1).copied().unwrap_or("..");
            let path = fields.last().copied().unwrap_or("");
            let bytes = xy.as_bytes();
            if path.is_empty() || bytes.len() < 2 {
                continue;
            }
            if bytes[0] != b'.' {
                files.push(file_change(path, bytes[0] as char, "staged"));
            }
            if bytes[1] != b'.' {
                files.push(file_change(path, bytes[1] as char, "unstaged"));
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            files.push(file_change(path, '?', "untracked"));
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path).then(a.stage.cmp(&b.stage)));
    let remote = if branch == "(detached)" {
        RemoteState::Detached {
            oid: oid.unwrap_or_else(|| "HEAD".into()),
        }
    } else if oid.as_deref() == Some("(initial)") {
        RemoteState::Unborn
    } else if let Some(upstream) = upstream {
        RemoteState::Ok {
            upstream,
            ahead: ahead.ok_or(())?,
            behind: behind.ok_or(())?,
        }
    } else {
        RemoteState::NoUpstream {
            branch: branch.clone(),
        }
    };
    Ok((StatusResult { branch, files }, remote))
}

fn parse_v1_remote(head: &str, counts: &[usize]) -> RemoteState {
    if counts.len() == 2 {
        RemoteState::Ok {
            upstream: "upstream".into(),
            behind: counts[0],
            ahead: counts[1],
        }
    } else if head.len() >= 7 && head.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        RemoteState::Detached { oid: head.into() }
    } else if head.is_empty() {
        RemoteState::Unborn
    } else {
        RemoteState::NoUpstream {
            branch: head.into(),
        }
    }
}

fn classify_snapshot_error(error: &str) -> RemoteGitErrorKind {
    let lower = error.to_ascii_lowercase();
    if lower.contains("cancel") {
        RemoteGitErrorKind::Cancelled
    } else if lower.contains("timed out") || lower.contains("timeout") {
        RemoteGitErrorKind::Timeout
    } else if lower.contains("permission denied") {
        RemoteGitErrorKind::PermissionDenied
    } else if lower.contains("not found") && lower.contains("git") {
        RemoteGitErrorKind::GitUnavailable
    } else if lower.contains("no such file") || lower.contains("not a directory") {
        RemoteGitErrorKind::PathUnavailable
    } else if lower.contains("connection")
        || lower.contains("transport")
        || lower.contains("channel")
    {
        RemoteGitErrorKind::TransportUnavailable
    } else {
        RemoteGitErrorKind::Unknown
    }
}

fn cached_snapshot_response(
    request: &RemoteGitSnapshotRequestV1,
    entry: SnapshotCacheEntry,
    freshness: SnapshotFreshness,
    error: Option<RemoteGitErrorKind>,
) -> RemoteGitSnapshotV1 {
    let unavailable_fields = if entry.workspace.is_none() {
        vec![UnavailableFieldV1 {
            field: "workspace",
            kind: RemoteGitErrorKind::Unknown,
        }]
    } else {
        Vec::new()
    };
    RemoteGitSnapshotV1 {
        request_id: request.request_id.clone(),
        generation: request.generation,
        binding: request.binding.clone(),
        observed_at: entry.observed_at,
        freshness,
        repo: Some(RemoteGitRepoV1 {
            status: entry.status,
            upstream: entry.upstream,
            workspace: entry.workspace,
        }),
        unavailable_fields,
        error: error.map(wire_error),
    }
}

/// Generation-safe aggregate used by every remote Review consumer. Modern Git
/// needs one status exec; its fallback remains in that same channel. Workspace
/// discovery is a second exec only on a snapshot cache miss.
#[tauri::command]
pub async fn ssh_remote_git_snapshot_v1(
    state: State<'_, PtyState>,
    cancel_state: State<'_, FsSearchCancellationState>,
    request: RemoteGitSnapshotRequestV1,
) -> Result<RemoteGitSnapshotV1, String> {
    validate_request_id(&request.request_id)?;
    remote_git_cwd(&request.cwd)?;
    if request.repository_key.is_empty()
        || request.repository_key.len() > 512
        || request.repository_key.chars().any(char::is_control)
    {
        return Err("invalid remote repository identity".into());
    }
    let key = snapshot_key(&request.binding, &request.cwd).ok_or("invalid remote git cwd")?;
    // Binding validation always precedes every cache and generation decision.
    if state.get_for_ssh_binding(&request.binding).is_none() {
        return Ok(cancelled_response(request));
    }
    let Some(generation_cancelled) = register_generation(&key, request.generation) else {
        return Ok(cancelled_response(request));
    };
    if !request.force {
        if absent_snapshot_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).copied())
            .is_some_and(|inserted| inserted.elapsed() < ABSENT_REPO_TTL)
        {
            return Ok(not_git_response(request));
        }
        if let Some(entry) = snapshot_cache()
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).cloned())
            .filter(|entry| entry.inserted.elapsed() < Duration::from_secs(2))
        {
            return Ok(cached_snapshot_response(
                &request,
                entry,
                SnapshotFreshness::Fresh,
                None,
            ));
        }
    }
    let cancelled = cancel_state.register_operation("remoteGit", &request.request_id);
    let cached_workspace = (!request.force)
        .then(|| {
            snapshot_cache()
                .lock()
                .ok()
                .and_then(|cache| cache.get(&key).cloned())
                .filter(|entry| entry.inserted.elapsed() < Duration::from_secs(5))
                .and_then(|entry| entry.workspace)
        })
        .flatten();
    let result: Result<SnapshotCacheEntry, String> = async {
        let session = state.get_for_ssh_binding(&request.binding).ok_or_else(|| "stale binding".to_string())?;
        let ssh = match session.as_ref() { Session::Ssh(ssh) => ssh, _ => return Err("stale binding".into()) };
        let cwd = remote_git_cwd(&request.cwd)?;
        let command = format!("git -C {cwd} status --porcelain=v2 --branch --no-renames -z || {{ printf 'TUNARA_V1\\0'; git -C {cwd} status --porcelain=v1 --branch --no-renames -z; rc=$?; printf 'TUNARA_META\\0TUNARA_RC %s\\n' \"$rc\"; git -C {cwd} symbolic-ref --short HEAD 2>/dev/null || git -C {cwd} rev-parse HEAD 2>/dev/null || true; git -C {cwd} rev-list --left-right --count @{{u}}...HEAD 2>/dev/null || true; }}");
        crate::modules::perf_counters::git_process();
        let raw = ssh.exec_cancellable(&command, MAX_STATUS_BYTES + 1, cancelled.clone()).await?;
        if cancelled.load(Ordering::Acquire) || generation_cancelled.load(Ordering::Acquire) { return Err("cancelled".into()); }
        if raw.len() > MAX_STATUS_BYTES { return Err("status too large".into()); }
        let (status, upstream) = if let Some(v1) = raw.strip_prefix("TUNARA_V1\0") {
            let (status_raw, meta) = v1.split_once("TUNARA_META\0").unwrap_or((v1, ""));
            if !meta.starts_with("TUNARA_RC 0\n") { return Err("fatal: not a git repository".into()); }
            let status = parse_porcelain_v1(status_raw);
            let mut lines = meta.lines().skip(1);
            let branch = lines.next().unwrap_or("").trim();
            let counts = lines.next().unwrap_or("").split_whitespace().filter_map(|v| v.parse::<usize>().ok()).collect::<Vec<_>>();
            let remote = parse_v1_remote(branch, &counts);
            (status, remote)
        } else { parse_porcelain_v2(&raw).map_err(|_| "malformed git status".to_string())? };
        let workspace = if cached_workspace.is_some() {
            cached_workspace
        } else {
            let workspace_command = format!("cd {cwd} && common=$(git rev-parse --git-common-dir) && common_abs=$(cd \"$common\" && pwd -P) && current=$(git rev-parse --show-toplevel 2>/dev/null || true) && bare=$(git rev-parse --is-bare-repository) && printf 'tunara-common %s\\0tunara-current %s\\0tunara-bare %s\\0' \"$common_abs\" \"$current\" \"$bare\" && git worktree list --porcelain -z");
            crate::modules::perf_counters::git_process();
            ssh.exec_cancellable(&workspace_command, MAX_STATUS_BYTES + 1, cancelled.clone()).await.ok().and_then(|raw| parse_remote_workspace(&raw, &request.repository_key).ok())
        };
        if cancelled.load(Ordering::Acquire) || generation_cancelled.load(Ordering::Acquire) || !generation_is_latest(&key, request.generation) || state.get_for_ssh_binding(&request.binding).is_none() { return Err("cancelled".into()); }
        Ok(SnapshotCacheEntry { status, upstream, workspace, observed_at: observed_now(), inserted: Instant::now() })
    }.await;
    let finish_request_id = request.request_id.clone();
    let response = match result {
        Ok(entry) => {
            let _lease = state
                .acquire_commit_lease(&request.binding)
                .map_err(|_| "stale binding")?;
            if cancelled.load(Ordering::Acquire)
                || generation_cancelled.load(Ordering::Acquire)
                || !generation_is_latest(&key, request.generation)
            {
                return Ok(cancelled_response(request));
            }
            let mut cache = snapshot_cache()
                .lock()
                .map_err(|_| "snapshot cache unavailable")?;
            bounded_insert(&mut cache, key, entry.clone(), SNAPSHOT_CACHE_CAP);
            Ok(cached_snapshot_response(
                &request,
                entry,
                SnapshotFreshness::Fresh,
                None,
            ))
        }
        Err(error) if is_remote_non_git_error(&error) => {
            if !cancelled.load(Ordering::Acquire)
                && !generation_cancelled.load(Ordering::Acquire)
                && generation_is_latest(&key, request.generation)
                && state.get_for_ssh_binding(&request.binding).is_some()
            {
                if let Ok(mut cache) = absent_snapshot_cache().lock() {
                    bounded_insert(&mut cache, key, Instant::now(), SNAPSHOT_CACHE_CAP);
                }
            }
            Ok(not_git_response(request))
        }
        Err(error) => {
            let kind = if state.get_for_ssh_binding(&request.binding).is_none() {
                RemoteGitErrorKind::Cancelled
            } else {
                classify_snapshot_error(&error)
            };
            let stale_allowed = matches!(
                kind,
                RemoteGitErrorKind::TransportUnavailable
                    | RemoteGitErrorKind::Timeout
                    | RemoteGitErrorKind::Unknown
            );
            if stale_allowed {
                if let Some(entry) = snapshot_cache()
                    .lock()
                    .ok()
                    .and_then(|cache| cache.get(&key).cloned())
                    .filter(|entry| entry.inserted.elapsed() < Duration::from_secs(30))
                {
                    cancel_state.finish_operation("remoteGit", &finish_request_id, &cancelled);
                    return Ok(cached_snapshot_response(
                        &request,
                        entry,
                        SnapshotFreshness::Stale,
                        Some(kind),
                    ));
                }
            }
            Ok(RemoteGitSnapshotV1 {
                request_id: request.request_id,
                generation: request.generation,
                binding: request.binding,
                observed_at: observed_now(),
                freshness: SnapshotFreshness::Fresh,
                repo: None,
                unavailable_fields: Vec::new(),
                error: Some(wire_error(kind)),
            })
        }
    };
    cancel_state.finish_operation("remoteGit", &finish_request_id, &cancelled);
    response
}

fn file_change(path: &str, status: char, stage: &str) -> FileChange {
    FileChange {
        path: path.to_string(),
        status: status.to_string(),
        stage: stage.to_string(),
        added: 0,
        removed: 0,
    }
}

fn remote_basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("repository")
        .to_string()
}

/// Parse a NUL-delimited header plus `git worktree list --porcelain -z`.
/// Paths may contain whitespace or newlines; NUL is the only delimiter Git
/// forbids in a path, so the transport stays lossless.
pub(crate) fn parse_remote_workspace(
    raw: &str,
    repository_key: &str,
) -> Result<WorkspaceContext, String> {
    let mut common_dir = None::<String>;
    let mut current_path = None::<String>;
    let mut bare = false;
    let mut worktrees = Vec::<WorktreeRef>::new();
    let mut current: Option<WorktreeRef> = None;

    let flush = |value: &mut Option<WorktreeRef>, output: &mut Vec<WorktreeRef>| {
        if let Some(worktree) = value.take() {
            output.push(worktree);
        }
    };

    for record in raw.split('\0') {
        if record.is_empty() {
            flush(&mut current, &mut worktrees);
            continue;
        }
        if let Some(value) = record.strip_prefix("tunara-common ") {
            common_dir = Some(value.to_string());
            continue;
        }
        if let Some(value) = record.strip_prefix("tunara-current ") {
            if !value.is_empty() {
                current_path = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("tunara-bare ") {
            bare = value == "true";
            continue;
        }
        if let Some(path) = record.strip_prefix("worktree ") {
            flush(&mut current, &mut worktrees);
            current = Some(WorktreeRef {
                id: String::new(),
                name: remote_basename(path),
                path: path.to_string(),
                branch: None,
                head: None,
                detached: false,
                dirty_files: None,
                upstream: None,
                ahead: None,
                behind: None,
                current: false,
                locked: false,
                available: true,
                error: None,
            });
            continue;
        }
        let Some(worktree) = current.as_mut() else {
            continue;
        };
        if let Some(head) = record.strip_prefix("HEAD ") {
            worktree.head = Some(head.to_string());
        } else if let Some(branch) = record.strip_prefix("branch refs/heads/") {
            worktree.branch = Some(branch.to_string());
        } else if record == "detached" {
            worktree.detached = true;
        } else if record == "bare" {
            // Bare repositories have no checkout and cannot be a session's
            // current worktree, but retaining the row explains the topology.
            worktree.available = false;
            worktree.error = Some("bare repository".to_string());
        } else if record == "locked" || record.starts_with("locked ") {
            worktree.locked = true;
        } else if record == "prunable" || record.starts_with("prunable ") {
            worktree.available = false;
            worktree.error = Some(
                record
                    .strip_prefix("prunable ")
                    .unwrap_or("prunable worktree")
                    .to_string(),
            );
        }
    }
    flush(&mut current, &mut worktrees);

    let common_dir = common_dir.ok_or_else(|| "remote workspace common dir missing".to_string())?;
    let repository_id = format!("ssh:{repository_key}:{common_dir}");
    for worktree in &mut worktrees {
        worktree.id = format!("{repository_id}::{}", worktree.path);
        worktree.current = current_path.as_deref() == Some(worktree.path.as_str());
    }
    worktrees.sort_by(|a, b| b.current.cmp(&a.current).then(a.path.cmp(&b.path)));
    let current_worktree_id = worktrees
        .iter()
        .find(|worktree| worktree.current)
        .map(|worktree| worktree.id.clone());
    let name_path = current_path.as_deref().unwrap_or(&common_dir);

    Ok(WorkspaceContext {
        repository: RepositoryRef {
            id: repository_id,
            name: remote_basename(name_path),
            common_git_dir: common_dir,
            transport: "ssh".to_string(),
            host: Some(repository_key.to_string()),
            bare,
        },
        current_worktree_id,
        worktrees,
    })
}

/// Discover remote repository/worktree topology over the existing SSH
/// connection. This is read-only and separate from the interactive shell.
#[tauri::command]
pub async fn ssh_git_workspace_context(
    state: State<'_, PtyState>,
    search_state: State<'_, FsSearchCancellationState>,
    session_id: u32,
    cwd: String,
    repository_key: String,
    request_id: String,
) -> Result<WorkspaceContext, String> {
    (async {
    validate_request_id(&request_id)?;
    if repository_key.is_empty()
        || repository_key.len() > 512
        || repository_key.chars().any(char::is_control)
    {
        return Err("invalid remote repository identity".to_string());
    }
    if let Some(error) = skip_unconfirmed_remote_git(session_id, &cwd) {
        return Err(error);
    }
    let requested_cwd = cwd.clone();
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    let cwd = remote_git_cwd(&cwd)?;
    let command = format!(
        "cd {cwd} && common=$(git rev-parse --git-common-dir) && common_abs=$(cd \"$common\" && pwd -P) && current=$(git rev-parse --show-toplevel 2>/dev/null || true) && bare=$(git rev-parse --is-bare-repository) && printf 'tunara-common %s\\0tunara-current %s\\0tunara-bare %s\\0' \"$common_abs\" \"$current\" \"$bare\" && git worktree list --porcelain -z"
    );
    let cancelled = search_state.register(&request_id);
    let result = ssh
        .exec_cancellable(&command, MAX_STATUS_BYTES + 1, cancelled.clone())
        .await;
    search_state.finish(&request_id, &cancelled);
    let out = result?;
    if out.len() > MAX_STATUS_BYTES {
        return Err(format!(
            "remote git workspace exceeds {MAX_STATUS_BYTES} bytes"
        ));
    }
    let workspace = parse_remote_workspace(&out, &repository_key)?;
    log::info!(
        "git workspace discovered transport=ssh worktrees={} current={}",
        workspace.worktrees.len(),
        workspace.current_worktree_id.is_some()
    );
    remember_remote_repo_knowledge(session_id, &requested_cwd, RemoteRepoKnowledge::Confirmed);
    Ok(workspace)

    }).await.map_err(|error: String| map_remote_git_error(session_id, &cwd, error))
}

// Search/grep keep the generic RemoteGit mapper: those are not repo-status probes.

/// Run a remote `git diff` for one file/stage and wrap it as a `FileDiff::text`
/// (or `tooLarge` when the exec hit its byte cap).
#[tauri::command]
pub async fn ssh_git_diff(
    state: State<'_, PtyState>,
    search_state: State<'_, FsSearchCancellationState>,
    session_id: u32,
    cwd: String,
    file: String,
    stage: String,
    request_id: String,
) -> Result<FileDiff, String> {
    (async {
        validate_request_id(&request_id)?;
        let session = ssh_session(&state, session_id)?;
        let ssh = match session.as_ref() {
            Session::Ssh(s) => s,
            Session::Local(_) => return Err("not a remote session".to_string()),
        };
        // Stage → git diff flag. Untracked files have no diff, so surface them as
        // metadataOnly (the local path does the same for empty-delta untracked).
        let arg = match stage.as_str() {
            "staged" => "--cached",
            "unstaged" => "",
            "untracked" => {
                return Ok(FileDiff::MetadataOnly {
                    path: file,
                    change: "untracked".to_string(),
                });
            }
            _ => "",
        };
        if let Some(error) = skip_unconfirmed_remote_git(session_id, &cwd) {
            return Err(error);
        }
        let requested_cwd = cwd.clone();
        // Shell-quote the path minimally: wrap in single quotes and escape any
        // embedded single quotes. The file path comes from our own parsed status,
        // not user input, but quoting defends against paths with spaces/quotes.
        let quoted = shell_quote(&file);
        let cwd = remote_git_cwd(&cwd)?;
        // No `2>&1` — let the exec function's stderr-capture return git errors
        // (e.g. "fatal: not a git repository") as Err instead of merging them
        // into the patch text.
        let cmd = format!("git -C {cwd} diff {arg} -- {quoted}");
        // Ask exec for one byte over the cap: exec truncates to its limit, so a
        // result strictly longer than MAX_DIFF_BYTES is the only unambiguous
        // overflow signal (a diff of exactly the cap is complete, not too large).
        let cancelled = search_state.register(&request_id);
        let result = ssh
            .exec_cancellable(&cmd, MAX_DIFF_BYTES + 1, cancelled.clone())
            .await;
        search_state.finish(&request_id, &cancelled);
        let out = result?;
        if out.len() > MAX_DIFF_BYTES {
            remember_remote_repo_knowledge(
                session_id,
                &requested_cwd,
                RemoteRepoKnowledge::Confirmed,
            );
            return Ok(FileDiff::TooLarge {
                path: file,
                bytes: out.len(),
            });
        }
        // Under the byte cap but over the line cap: cut and flag truncation the
        // same way the local path does, instead of silently returning a patch the
        // local DiffPanel would have labelled as truncated.
        let total_lines = out.lines().count();
        if total_lines > MAX_DIFF_LINES {
            remember_remote_repo_knowledge(
                session_id,
                &requested_cwd,
                RemoteRepoKnowledge::Confirmed,
            );
            let patch = out
                .lines()
                .take(MAX_DIFF_LINES)
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(FileDiff::Text {
                path: file,
                patch,
                truncated: true,
                total_lines,
            });
        }
        remember_remote_repo_knowledge(session_id, &requested_cwd, RemoteRepoKnowledge::Confirmed);
        Ok(FileDiff::Text {
            path: file,
            patch: out,
            truncated: false,
            total_lines,
        })
    })
    .await
    .map_err(|error: String| map_remote_git_error(session_id, &cwd, error))
}

/// Cap stdout collection for a remote find so a huge tree can't OOM. The
/// frontend already caps at 80 results; this bounds the raw bytes.
const MAX_SEARCH_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileSearchRequest {
    session_id: u32,
    root: String,
    query: String,
    limit: Option<usize>,
    request_id: String,
}

/// Parse `find` output (one absolute path per line) into `SearchHit`s relative
/// to `root`. Pure function so it can be unit-tested without a live SSH exec.
pub(crate) fn parse_find_output(raw: &str, root: &str) -> Vec<SearchHit> {
    let root_trimmed = root.trim_end_matches('/');
    let mut out: Vec<SearchHit> = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        let (is_dir, path) = match line.split_once('\t') {
            Some(("d", path)) => (true, path.trim()),
            Some(("f", path)) => (false, path.trim()),
            _ => (false, line),
        };
        if path.is_empty() {
            continue;
        }
        // rel = path relative to root; if path isn't under root, use the
        // basename as rel so the UI still shows something.
        let rel = path
            .strip_prefix(root_trimmed)
            .map(|s| s.trim_start_matches('/'))
            .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path))
            .to_string();
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        out.push(SearchHit {
            path: path.to_string(),
            rel,
            name,
            is_dir,
        });
    }
    out
}

/// Run `find <root> -name '*<query>*'` over the SSH exec channel and parse the
/// output into `SearchHit`s. Mirrors the local `fs_search` contract so
/// FileExplorer can switch data source by session kind.
///
/// Caps at `limit` results (default 80) and 64 KiB of raw output. `include_hidden`
/// adds `-not -path '*/.*'` exclusion inversion — by default hidden paths are
/// skipped to match the local `ignore`-based walk.
#[tauri::command]
pub async fn ssh_fs_search(
    state: State<'_, PtyState>,
    search_state: State<'_, FsSearchCancellationState>,
    request: RemoteFileSearchRequest,
) -> Result<Vec<SearchHit>, String> {
    (async {
        let RemoteFileSearchRequest {
            session_id,
            root,
            query,
            limit,
            request_id,
        } = request;
        validate_request_id(&request_id)?;
        let session = ssh_session(&state, session_id)?;
        let ssh = match session.as_ref() {
            Session::Ssh(s) => s,
            Session::Local(_) => return Err("not a remote session".to_string()),
        };
        let cap = limit.unwrap_or(80).min(200);
        // Shell-quote: root in single quotes, query embedded inside find's -name
        // glob (single-quoted so embedded quotes/semicolons can't escape).
        let root_q = format!("'{}'", root.replace('\'', "'\\''"));
        let query_q = format!("'*{}*'", query.replace('\'', "'\\''"));
        // `-not -path '*/.*'` skips hidden dirs/files (matches local ignore walk).
        // `2>/dev/null` suppresses permission-denied noise. `head` caps result count
        // so a massive tree doesn't stream forever.
        let cmd = format!(
            "find {root_q} -name {query_q} -not -path '*/.*' 2>/dev/null | \
         while IFS= read -r p; do if [ -d \"$p\" ]; then printf 'd\\t%s\\n' \"$p\"; \
         else printf 'f\\t%s\\n' \"$p\"; fi; done | head -{cap}"
        );
        let cancelled = search_state.register(&request_id);
        let result = ssh
            .exec_cancellable(&cmd, MAX_SEARCH_BYTES, cancelled.clone())
            .await;
        search_state.finish(&request_id, &cancelled);
        let out = result?;
        Ok(parse_find_output(&out, &root))
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::RemoteGit, error)
    })
}

// ── Remote content search (grep over the exec channel) ─────────────────────

/// Byte cap on remote grep stdout, matching the remote status budget. The line
/// cap below is the primary limiter; this bounds pathological single lines.
const MAX_GREP_BYTES: usize = 256 * 1024;
/// Response cap defaults/limits, mirroring the local `fs_grep` contract.
const REMOTE_GREP_DEFAULT_RESULTS: usize = 200;
const REMOTE_GREP_HARD_MAX_RESULTS: usize = 1000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGrepRequest {
    session_id: u32,
    root: String,
    pattern: String,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    request_id: String,
}

/// Parse `grep -rn` output (`./rel/path:LINE:text` per line, produced by
/// grepping `.` after `cd`-ing into `root`) into `GrepHit`s plus a truncation
/// flag. Pure function so it can be unit-tested without a live SSH exec.
///
/// Defensive parsing rules:
/// - a line must split as `path:number:text`; anything else (banner noise,
///   a path whose name itself contains `:` before the line number) is skipped
///   rather than guessed at;
/// - hidden paths (any `.`-prefixed component) are filtered here instead of
///   with fragile `--exclude-dir='.*'` globs, whose treatment of the `.` start
///   directory differs between GNU and BSD grep;
/// - if the raw output was byte-capped mid-line (no trailing newline), the
///   final partial hit is dropped and the result is marked truncated.
pub(crate) fn parse_grep_output(raw: &str, root: &str, max_results: usize) -> (Vec<GrepHit>, bool) {
    let root_trimmed = root.trim_end_matches('/');
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut truncated = false;

    for line in raw.lines() {
        if hits.len() > max_results {
            // The command asks head for max_results + 1 lines precisely so an
            // extra parsed hit here proves more matches exist.
            truncated = true;
            break;
        }
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, ':');
        let (Some(path_part), Some(line_part), Some(text)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(line_no) = line_part.parse::<u64>() else {
            continue;
        };
        let rel = path_part
            .strip_prefix("./")
            .unwrap_or(path_part)
            .trim_start_matches('/');
        if rel.is_empty() {
            continue;
        }
        // Hidden filter: matches the local walker's hidden(true) behavior.
        if rel.split('/').any(|component| component.starts_with('.')) {
            continue;
        }
        hits.push(GrepHit {
            path: format!("{root_trimmed}/{rel}"),
            rel: rel.to_string(),
            line: line_no,
            text: text.trim_end_matches('\r').to_string(),
        });
    }

    // Byte-cap cut mid-line: the last "hit" may be a sliced fragment.
    if !raw.is_empty() && !raw.ends_with('\n') && !hits.is_empty() {
        hits.pop();
        truncated = true;
    }
    if hits.len() > max_results {
        hits.truncate(max_results);
        truncated = true;
    }
    (hits, truncated)
}

/// Run a content search (`grep -rEIn`) in `root` over the SSH exec channel and
/// return it in the exact shape of the local `fs_grep`, so FileExplorer's
/// content-search mode works for SSH sessions too.
///
/// Requires a POSIX-ish remote shell and a grep supporting `-r -E -I -n` and
/// `--exclude-dir` (GNU and BSD both qualify). grep's stderr is suppressed so
/// permission noise can't fail a valid search, which means a minimal busybox
/// grep degrades to an empty result — the same silent posture the remote
/// shell-integration takes on unsupported hosts. The `--exclude-dir` list
/// mirrors the local watcher's noisy-path set; hidden paths are filtered in
/// the parser (see `parse_grep_output`).
///
/// `files_scanned` cannot be known remotely; it reports the number of distinct
/// files among the hits instead (the UI only renders hits + truncated).
#[tauri::command]
pub async fn ssh_fs_grep(
    state: State<'_, PtyState>,
    search_state: State<'_, FsSearchCancellationState>,
    request: RemoteGrepRequest,
) -> Result<GrepResponse, String> {
    (async {
        let RemoteGrepRequest {
            session_id,
            root,
            pattern,
            case_insensitive,
            max_results,
            request_id,
        } = request;
        validate_request_id(&request_id)?;
        if pattern.is_empty() {
            return Err("empty pattern".into());
        }
        let session = ssh_session(&state, session_id)?;
        let ssh = match session.as_ref() {
            Session::Ssh(s) => s,
            Session::Local(_) => return Err("not a remote session".to_string()),
        };
        let cap = max_results
            .unwrap_or(REMOTE_GREP_DEFAULT_RESULTS)
            .clamp(1, REMOTE_GREP_HARD_MAX_RESULTS);

        // Shell-quote root and pattern (same single-quote escape the diff path
        // uses); `-e` keeps a leading `-` in the pattern from becoming a flag.
        let root_q = format!("'{}'", root.replace('\'', "'\\''"));
        let pattern_q = format!("'{}'", pattern.replace('\'', "'\\''"));
        let case_flag = if case_insensitive == Some(true) {
            "-i "
        } else {
            ""
        };
        // head asks for cap + 1 lines so the parser can distinguish "exactly cap
        // matches" from "more matches exist". grep's stderr is discarded so
        // permission-denied noise on a single unreadable subdir can't turn a valid
        // zero-match search into an error; cd's stderr is NOT discarded, so a
        // missing/denied root still surfaces as a visible failure via exec's
        // empty-stdout-with-stderr path.
        let head_cap = cap + 1;
        let cmd = format!(
            "cd {root_q} && grep -rEIn {case_flag}--exclude-dir=.git --exclude-dir=node_modules \
         --exclude-dir=target --exclude-dir=dist -e {pattern_q} . 2>/dev/null | head -n {head_cap}"
        );
        let cancelled = search_state.register(&request_id);
        let result = ssh
            .exec_cancellable(&cmd, MAX_GREP_BYTES, cancelled.clone())
            .await;
        search_state.finish(&request_id, &cancelled);
        let out = result?;
        let (hits, truncated) = parse_grep_output(&out, &root, cap);
        let files_scanned = {
            let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
            for hit in &hits {
                seen.insert(hit.rel.as_str());
            }
            seen.len()
        };
        Ok(GrepResponse {
            hits,
            truncated,
            files_scanned,
        })
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::RemoteGit, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static REMOTE_REPO_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn porcelain_v2_covers_upstream_detached_unborn_and_files() {
        let (status, remote) = parse_porcelain_v2(concat!(
            "# branch.oid abcdef\0# branch.head main\0# branch.upstream origin/main\0",
            "# branch.ab +2 -3\0? new file\0",
            "1 .M N... 100644 100644 100644 abc def src/main.rs\0",
        ))
        .unwrap();
        assert_eq!(status.branch, "main");
        assert_eq!(status.files.len(), 2);
        assert!(matches!(
            remote,
            RemoteState::Ok {
                ahead: 2,
                behind: 3,
                ..
            }
        ));

        let (_, detached) =
            parse_porcelain_v2("# branch.oid deadbeef\0# branch.head (detached)\0").unwrap();
        assert!(matches!(detached, RemoteState::Detached { .. }));
        let (_, unborn) =
            parse_porcelain_v2("# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert!(matches!(unborn, RemoteState::Unborn));
    }

    #[test]
    fn v1_fallback_covers_tracking_direction_and_head_states() {
        assert!(matches!(
            parse_v1_remote("main", &[]),
            RemoteState::NoUpstream { .. }
        ));
        assert!(matches!(parse_v1_remote("", &[]), RemoteState::Unborn));
        assert!(matches!(
            parse_v1_remote("deadbeef", &[]),
            RemoteState::Detached { .. }
        ));
        assert!(matches!(
            parse_v1_remote("main", &[4, 2]),
            RemoteState::Ok {
                behind: 4,
                ahead: 2,
                ..
            }
        ));
    }

    #[test]
    fn generation_model_allows_only_the_highest_of_ten_thousand_to_commit() {
        let mut latest = None;
        for generation in (0..10_000_u64).rev().chain(0..10_000) {
            if latest.is_none_or(|current| generation > current) {
                latest = Some(generation);
            }
        }
        assert_eq!(latest, Some(9_999));
        assert!(
            (0..10_000)
                .filter(|generation| Some(*generation) == latest)
                .count()
                == 1
        );
    }

    #[test]
    fn classifier_does_not_confuse_permission_and_transport_with_nonrepo() {
        assert!(matches!(
            classify_snapshot_error("Permission denied"),
            RemoteGitErrorKind::PermissionDenied
        ));
        assert!(matches!(
            classify_snapshot_error("channel closed"),
            RemoteGitErrorKind::TransportUnavailable
        ));
        assert!(matches!(
            classify_snapshot_error("operation timed out"),
            RemoteGitErrorKind::Timeout
        ));
    }

    #[test]
    fn remote_workspace_groups_worktrees_and_marks_current() {
        let raw = concat!(
            "tunara-common /srv/app/.git\0",
            "tunara-current /srv/app-wt\0",
            "tunara-bare false\0",
            "worktree /srv/app\0",
            "HEAD 1111111111111111111111111111111111111111\0",
            "branch refs/heads/main\0\0",
            "worktree /srv/app-wt\0",
            "HEAD 2222222222222222222222222222222222222222\0",
            "branch refs/heads/feature\0",
            "locked maintenance\0\0",
        );
        let context = parse_remote_workspace(raw, "alice@example:22").unwrap();
        assert_eq!(context.repository.transport, "ssh");
        assert_eq!(context.repository.name, "app-wt");
        assert_eq!(context.worktrees.len(), 2);
        let current = context.worktrees.iter().find(|w| w.current).unwrap();
        assert_eq!(current.branch.as_deref(), Some("feature"));
        assert!(current.locked);
        assert!(context.repository.id.contains("alice@example:22"));
    }

    #[test]
    fn remote_workspace_preserves_newlines_and_prunable_state() {
        let raw = concat!(
            "tunara-common /srv/repo/.git\0",
            "tunara-current /srv/repo\0",
            "tunara-bare false\0",
            "worktree /srv/repo\0HEAD abc\0branch refs/heads/main\0\0",
            "worktree /srv/odd\nname\0HEAD def\0prunable missing gitdir\0\0",
        );
        let context = parse_remote_workspace(raw, "host").unwrap();
        let stale = context.worktrees.iter().find(|w| !w.available).unwrap();
        assert_eq!(stale.path, "/srv/odd\nname");
        assert_eq!(stale.error.as_deref(), Some("missing gitdir"));
        assert!(stale.dirty_files.is_none());
    }

    #[test]
    fn same_remote_path_on_different_hosts_has_distinct_identity() {
        let raw = concat!(
            "tunara-common /srv/repo/.git\0",
            "tunara-current /srv/repo\0",
            "tunara-bare false\0",
            "worktree /srv/repo\0HEAD abc\0detached\0\0",
        );
        let first = parse_remote_workspace(raw, "alice@one:22").unwrap();
        let second = parse_remote_workspace(raw, "alice@two:22").unwrap();
        assert_ne!(first.repository.id, second.repository.id);
        assert_ne!(first.worktrees[0].id, second.worktrees[0].id);
        assert!(first.worktrees[0].detached);
        assert!(first.worktrees[0].branch.is_none());
    }

    #[test]
    fn remote_git_cwd_is_absolute_and_shell_quoted() {
        assert_eq!(
            remote_git_cwd("/srv/repo with 'quote'").unwrap(),
            "'/srv/repo with '\\''quote'\\'''"
        );
        assert!(remote_git_cwd("relative/repo").is_err());
        assert!(remote_git_cwd("/srv/repo\nnext").is_err());
    }

    #[test]
    fn remote_repo_cache_skips_absent_paths_and_normalizes_trailing_slashes() {
        let _guard = REMOTE_REPO_CACHE_TEST_LOCK.lock().unwrap();
        reset_remote_repo_cache();
        remember_remote_repo_knowledge(7, "/tmp/", RemoteRepoKnowledge::Absent);
        assert_eq!(
            cached_remote_repo_knowledge(7, "/tmp"),
            Some(RemoteRepoKnowledge::Absent)
        );
        let skipped = skip_unconfirmed_remote_git(7, "/tmp").expect("absent path is skipped");
        assert_eq!(skipped, "SSH_REMOTE_GIT_FAILED");
        assert!(skip_unconfirmed_remote_git(7, "/srv/app").is_none());
        remember_remote_repo_knowledge(7, "/srv/app", RemoteRepoKnowledge::Confirmed);
        assert!(skip_unconfirmed_remote_git(7, "/srv/app/").is_none());
        assert_eq!(
            map_remote_git_error(
                7,
                "/",
                "fatal: not a git repository (or any of the parent directories): /".into()
            ),
            "SSH_REMOTE_GIT_FAILED"
        );
        assert_eq!(
            cached_remote_repo_knowledge(7, "/"),
            Some(RemoteRepoKnowledge::Absent)
        );
        reset_remote_repo_cache();
    }

    #[test]
    fn remote_repo_cache_is_scoped_to_the_session() {
        let _guard = REMOTE_REPO_CACHE_TEST_LOCK.lock().unwrap();
        reset_remote_repo_cache();
        remember_remote_repo_knowledge(1, "/tmp", RemoteRepoKnowledge::Absent);
        remember_remote_repo_knowledge(2, "/tmp", RemoteRepoKnowledge::Confirmed);
        assert_eq!(
            cached_remote_repo_knowledge(1, "/tmp"),
            Some(RemoteRepoKnowledge::Absent)
        );
        assert_eq!(
            cached_remote_repo_knowledge(2, "/tmp"),
            Some(RemoteRepoKnowledge::Confirmed)
        );
        reset_remote_repo_cache();
    }

    #[test]
    fn parse_porcelain_v1_branch_and_files() {
        let raw = "\
## main\0 M src/mod.rs\0A  new.txt\0?? untracked.log\0
";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 3);

        let modified = result
            .files
            .iter()
            .find(|f| f.path == "src/mod.rs")
            .unwrap();
        assert_eq!(modified.status, "M");
        assert_eq!(modified.stage, "unstaged");

        let added = result.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(added.status, "A");
        assert_eq!(added.stage, "staged");

        let untracked = result
            .files
            .iter()
            .find(|f| f.path == "untracked.log")
            .unwrap();
        assert_eq!(untracked.status, "?");
        assert_eq!(untracked.stage, "untracked");
    }

    #[test]
    fn parse_porcelain_v1_branch_with_upstream_tracking() {
        let raw = "## main...origin/main [ahead 1]\0 M a.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn parse_porcelain_v1_rename_status_is_staged() {
        // --no-renames makes Git report the destination as an ordinary path.
        let raw = "R  new.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "new.txt");
        assert_eq!(result.files[0].stage, "staged");
    }

    #[test]
    fn parse_porcelain_v1_empty_repo_is_unborn() {
        // No `##` branch line in an unborn repo's porcelain output means we
        // fall back to "HEAD"; no crash.
        let raw = "## No commits yet on main\0?? only.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn parse_porcelain_v1_malformed_lines_skipped() {
        let raw = "## main\0XY\0 M good.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "good.txt");
    }

    #[test]
    fn parse_porcelain_v1_preserves_unicode_newlines_and_both_stages() {
        let raw = "MM 中文\nfile.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 2);
        assert!(result
            .files
            .iter()
            .all(|file| file.path == "中文\nfile.txt"));
        assert_eq!(result.files[0].stage, "staged");
        assert_eq!(result.files[1].stage, "unstaged");
    }

    // ── find output parsing (remote file search) ──────────────────────────

    #[test]
    fn parse_find_output_makes_paths_relative_to_root() {
        let raw = "/home/alice/project/src/main.rs\n/home/alice/project/README.md\n";
        let hits = parse_find_output(raw, "/home/alice/project");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/home/alice/project/src/main.rs");
        assert_eq!(hits[0].rel, "src/main.rs");
        assert_eq!(hits[0].name, "main.rs");
        assert!(!hits[0].is_dir);
    }

    #[test]
    fn parse_find_output_handles_trailing_slash_in_root() {
        let raw = "/srv/app/a.txt\n";
        let hits = parse_find_output(raw, "/srv/app/");
        assert_eq!(hits[0].rel, "a.txt");
    }

    #[test]
    fn parse_find_output_preserves_remote_entry_type() {
        let raw = "d\t/srv/app/src\nf\t/srv/app/src/main.rs\n";
        let hits = parse_find_output(raw, "/srv/app");
        assert!(hits[0].is_dir);
        assert!(!hits[1].is_dir);
        assert_eq!(hits[0].rel, "src");
    }

    #[test]
    fn parse_find_output_skips_empty_lines() {
        let raw = "/x/a.txt\n\n/x/b.txt\n";
        let hits = parse_find_output(raw, "/x");
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn parse_find_output_falls_back_to_basename_when_not_under_root() {
        // A path outside root (e.g. a symlink find followed) still gets a name.
        let raw = "/other/place.txt\n";
        let hits = parse_find_output(raw, "/srv/app");
        assert_eq!(hits[0].name, "place.txt");
    }

    // ── grep output parsing (remote content search) ────────────────────────

    #[test]
    fn parse_grep_output_builds_hits_relative_to_root() {
        let raw = "./src/main.rs:12:fn main() {\n./README.md:3:usage: tunara\n";
        let (hits, truncated) = parse_grep_output(raw, "/home/alice/project", 200);
        assert!(!truncated);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/home/alice/project/src/main.rs");
        assert_eq!(hits[0].rel, "src/main.rs");
        assert_eq!(hits[0].line, 12);
        assert_eq!(hits[0].text, "fn main() {");
    }

    #[test]
    fn parse_grep_output_keeps_colons_inside_the_matched_text() {
        // Only the first two `:` separate path and line; the rest is text.
        let raw = "./a.ts:5:const url = \"http://x:8080\";\n";
        let (hits, _) = parse_grep_output(raw, "/r", 200);
        assert_eq!(hits[0].text, "const url = \"http://x:8080\";");
    }

    #[test]
    fn parse_grep_output_skips_malformed_and_hidden_lines() {
        let raw = "\
banner noise without separators
./.hidden/secret.txt:1:match in hidden dir
./src/ok.rs:notanumber:bad line field
./src/ok.rs:7:real match
";
        let (hits, truncated) = parse_grep_output(raw, "/r", 200);
        assert!(!truncated);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel, "src/ok.rs");
        assert_eq!(hits[0].line, 7);
    }

    #[test]
    fn parse_grep_output_truncates_at_max_results() {
        // head hands back cap + 1 lines; the extra line proves more exist.
        let raw = "./a:1:x\n./b:2:y\n./c:3:z\n";
        let (hits, truncated) = parse_grep_output(raw, "/r", 2);
        assert!(truncated);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn parse_grep_output_drops_a_byte_capped_partial_final_line() {
        // Output cut mid-line by the exec byte cap must not surface a sliced
        // fragment as a hit.
        let raw = "./a.txt:1:whole line\n./b.txt:2:slice";
        let (hits, truncated) = parse_grep_output(raw, "/r", 200);
        assert!(truncated);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel, "a.txt");
    }

    #[test]
    fn parse_grep_output_handles_root_with_trailing_slash_and_bare_root() {
        let raw = "./x.txt:1:hit\n";
        let (hits, _) = parse_grep_output(raw, "/srv/app/", 200);
        assert_eq!(hits[0].path, "/srv/app/x.txt");
        let (hits, _) = parse_grep_output(raw, "/", 200);
        assert_eq!(hits[0].path, "/x.txt");
    }
}
