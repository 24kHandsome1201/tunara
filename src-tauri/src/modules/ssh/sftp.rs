// Remote file operations over SFTP (Phase 3).
//
// These mirror the local fs_* commands' return shapes (DirEntry / ReadResult)
// so the frontend FileExplorer can switch data source by session kind without
// caring about the transport. Read-only browse + download only — no remote
// plus the conflict-safe text-write contract used by the Phase 2 editor.
//
// Each command takes the session `id` (the same u32 PtyState id the terminal
// uses) and reaches the live SSH connection's SFTP subsystem.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::connection::await_stage;
use super::diagnostics::SessionBindingV1;
use super::safe_write::{
    write_text_transaction, IoError, RemoteFile, RemoteFileKind, RemoteWriteIo, ReplaceError,
    TransactionOutcome, TransactionStage, WriteRequest,
};
use crate::modules::fs::head::{
    finish_tail, remote_revision, validate_line_limit, FileHeadResultV1, FileViewErrorV1,
    HeadAccumulator, RequestRegistration, HEAD_CHUNK_BYTES, MAX_HEAD_BYTES,
};
use crate::modules::pty::{PtyState, Session};

// 256 KiB preview cap, matching the local fs_read_file UI preview budget.
const MAX_TEXT_PREVIEW_BYTES: u64 = 256 * 1024;
// 10 MiB hard read cap, matching local fs.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;
const MAX_REMOTE_DIR_ENTRIES: usize = 10_000;
const MAX_REMOTE_DIR_NAME_BYTES: usize = 4 * 1024 * 1024;
const SFTP_CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_DIRECTORY_TIMEOUT: Duration = Duration::from_secs(30);
const SFTP_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);
const SFTP_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const SFTP_WRITE_TIMEOUT: Duration = Duration::from_secs(60);
const REPLACE_LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);
type UploadCancellationTable = HashMap<String, Arc<AtomicBool>>;
static UPLOAD_CANCELLATIONS: OnceLock<std::sync::Mutex<UploadCancellationTable>> = OnceLock::new();
type RemoteWriteLock = Arc<tokio::sync::Mutex<()>>;
type RemoteWriteLockKey = (u32, String);
type RemoteWriteLockTable = HashMap<RemoteWriteLockKey, Weak<tokio::sync::Mutex<()>>>;
static REMOTE_WRITE_LOCKS: OnceLock<std::sync::Mutex<RemoteWriteLockTable>> = OnceLock::new();

struct UploadRegistration {
    transfer_id: String,
    cancelled: Arc<AtomicBool>,
}

impl UploadRegistration {
    fn register(transfer_id: &str) -> Result<Self, String> {
        if transfer_id.is_empty() || transfer_id.len() > 128 {
            return Err("invalid upload transfer id".into());
        }
        let table = UPLOAD_CANCELLATIONS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
        let mut table = table
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if table.contains_key(transfer_id) {
            return Err("upload transfer id is already active".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        table.insert(transfer_id.to_string(), Arc::clone(&cancelled));
        Ok(Self {
            transfer_id: transfer_id.to_string(),
            cancelled,
        })
    }

    fn begin_commit(&self) -> Result<(), String> {
        let table = UPLOAD_CANCELLATIONS
            .get()
            .ok_or_else(|| "upload cancellation registry unavailable".to_string())?;
        let mut table = table
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.cancelled.load(Ordering::Acquire) {
            return Err("upload cancelled".into());
        }
        if table
            .get(&self.transfer_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
        {
            table.remove(&self.transfer_id);
            Ok(())
        } else {
            Err("upload cancellation registry changed unexpectedly".into())
        }
    }
}

impl Drop for UploadRegistration {
    fn drop(&mut self) {
        let Some(table) = UPLOAD_CANCELLATIONS.get() else {
            return;
        };
        let mut table = table
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if table
            .get(&self.transfer_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.cancelled))
        {
            table.remove(&self.transfer_id);
        }
    }
}

#[derive(Clone, Serialize)]
pub struct UploadProgress {
    pub(crate) transferred: u64,
    pub(crate) total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadCommandError<'a> {
    kind: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    residue_path: Option<&'a str>,
}

fn encode_upload_error(kind: &str, message: &str, residue_path: Option<&str>) -> String {
    let payload = UploadCommandError {
        kind,
        message,
        residue_path,
    };
    match serde_json::to_string(&payload) {
        Ok(json) => format!("tunaraUploadError:{json}"),
        Err(_) => message.to_string(),
    }
}

async fn validate_upload_replace_target(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
) -> Result<u32, String> {
    let metadata = await_stage(
        "validate remote upload replacement target",
        SFTP_CONTROL_TIMEOUT,
        sftp.symlink_metadata(remote_path),
    )
    .await
    .map_err(|_| "remote destination changed before replacement".to_string())?;
    if metadata.is_symlink() || !metadata.is_regular() {
        return Err("remote upload replacement target must be a regular non-symlink file".into());
    }
    metadata
        .permissions
        .map(|mode| mode & 0o7777)
        .ok_or_else(|| "remote server did not report replacement file permissions".to_string())
}

fn upload_residue_error(partial_path: &str, error: String) -> String {
    // SFTP v3 has no compare-and-unlink operation. Once the upload handle is
    // closed, removing this pathname could delete a regular file substituted
    // by another remote process. Fail closed and tell the user exactly which
    // private (0600) residue may need inspection/removal.
    let kind = if error == "upload cancelled" {
        "cancelled"
    } else if error.contains("permissions changed during upload") {
        "changed"
    } else {
        "partial"
    };
    encode_upload_error(kind, &error, Some(partial_path))
}

fn uncertain_upload_error(partial_path: &str) -> String {
    encode_upload_error(
        "uncertain",
        "upload outcome unknown after replacement; refresh the remote directory before retrying",
        Some(partial_path),
    )
}

fn preserved_upload_mode(initial_mode: u32, final_mode: u32) -> Result<u32, String> {
    if final_mode != initial_mode {
        return Err(
            "remote destination permissions changed during upload; retry after reviewing the file"
                .into(),
        );
    }
    Ok(final_mode & 0o7777)
}

fn remote_write_lock(id: u32, path: &str) -> RemoteWriteLock {
    let locks = REMOTE_WRITE_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Weak entries avoid retaining one mutex forever for every remote path a
    // user has ever edited. Opportunistic pruning keeps the table bounded by
    // currently active paths (plus at most the most recently released entry).
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = (id, path.to_string());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct RemoteDirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteReadResult {
    Text {
        content: String,
        size: u64,
        truncated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
    },
    Binary {
        size: u64,
    },
    Image {
        bytes: Vec<u8>,
        size: u64,
        mime: &'static str,
        width: u32,
        height: u32,
    },
    ImageTooLarge {
        size: u64,
        width: u32,
        height: u32,
        #[serde(rename = "maxPixels")]
        max_pixels: u64,
    },
    TooLarge {
        size: u64,
        limit: u64,
    },
}

fn content_fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn remote_mtime_millis(seconds: u32) -> u64 {
    u64::from(seconds).saturating_mul(1_000)
}

fn validate_fingerprint(fingerprint: &str) -> Result<(), String> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("expected fingerprint must be a lowercase SHA-256 hex digest".into());
    }
    Ok(())
}

pub(super) fn validate_remote_edit_path(path: &str) -> Result<(&Path, &str), String> {
    if path.contains(['\0', '\n', '\r']) {
        return Err("editable path contains unsupported control characters".into());
    }
    let parsed = Path::new(path);
    if !parsed.is_absolute() {
        return Err("editable path must be absolute".into());
    }
    if parsed
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("editable path must not contain '..'".into());
    }
    let name = parsed
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "editable path must name a UTF-8 file".to_string())?;
    Ok((parsed, name))
}

fn remote_sibling_temp_path(path: &str, attempt: u32) -> Result<String, String> {
    let (parsed, name) = validate_remote_edit_path(path)?;
    let parent = parsed
        .parent()
        .ok_or_else(|| "editable path has no parent".to_string())?;
    // Unpredictability is part of cleanup safety: a remote process must not be
    // able to guess this pathname and substitute an unrelated file before a
    // failed/cancelled transaction removes its residue.
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|_| "could not generate a secure remote temporary name".to_string())?;
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(parent
        .join(format!(".{name}.tunara-{nonce}-{attempt}.tmp"))
        .to_string_lossy()
        .into_owned())
}

fn remote_replace_lock_path(path: &str) -> Result<String, String> {
    let (parsed, _) = validate_remote_edit_path(path)?;
    let parent = parsed
        .parent()
        .ok_or_else(|| "editable path has no parent".to_string())?;
    let target_hash = content_fingerprint(path.as_bytes());
    Ok(parent
        .join(format!(".tunara-write-{target_hash}.lock"))
        .to_string_lossy()
        .into_owned())
}

fn remote_replace_lock_owner_path(path: &str) -> Result<String, String> {
    Ok(Path::new(&remote_replace_lock_path(path)?)
        .join("owner")
        .to_string_lossy()
        .into_owned())
}

async fn read_remote_replace_lock_owner(
    sftp: &russh_sftp::client::SftpSession,
    target: &str,
) -> Result<String, IoError> {
    let owner_path = remote_replace_lock_owner_path(target).map_err(IoError)?;
    let mut file = sftp
        .open(&owner_path)
        .await
        .map_err(|error| IoError(error.to_string()))?;
    let mut bytes = Vec::with_capacity(64);
    (&mut file)
        .take(65)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| IoError(error.to_string()))?;
    if bytes.len() != 64 {
        return Err(IoError("remote replace lock owner is malformed".into()));
    }
    let owner = String::from_utf8(bytes)
        .map_err(|_| IoError("remote replace lock owner is not UTF-8".into()))?;
    validate_fingerprint(&owner).map_err(IoError)?;
    Ok(owner)
}

fn stale_replace_lock_error(lock: &str, age_seconds: u64, owner: Option<&str>) -> IoError {
    let owner = owner.unwrap_or("unknown");
    IoError(format!(
        "remote replace lock appears stale (age={age_seconds}s, owner={owner}); \
         refusing automatic removal; reconcile the interrupted save or verify no writer is active before removing {lock}"
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Resolve the SshSession behind a session id, or a descriptive error.
pub(crate) async fn sftp_for(
    state: &tauri::State<'_, PtyState>,
    id: u32,
) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
    super::sftp_common::session(state.inner(), id).await
}

fn usable_remote_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// List a remote directory. Mirrors fs_read_dir: dirs first, hidden filtered
/// unless requested, sorted by name within kind.
#[tauri::command]
pub async fn ssh_fs_read_dir(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<RemoteDirEntry>, String> {
    (async {
        let include_hidden = include_hidden.unwrap_or(false);
        let session = state.get(id).ok_or_else(|| "no session".to_string())?;
        let entries = match session.as_ref() {
            Session::Ssh(ssh) => {
                ssh.read_dir_bounded(
                    &path,
                    MAX_REMOTE_DIR_ENTRIES,
                    MAX_REMOTE_DIR_NAME_BYTES,
                    SFTP_DIRECTORY_TIMEOUT,
                )
                .await?
            }
            Session::Local(_) => return Err("not a remote session".to_string()),
        };

        let mut out: Vec<RemoteDirEntry> = Vec::new();
        for entry in entries {
            let name = entry.filename;
            if !usable_remote_dir_name(&name) {
                continue;
            }
            if !include_hidden && name.starts_with('.') {
                continue;
            }
            let meta = entry.attrs;
            let kind = if meta.is_dir() {
                EntryKind::Dir
            } else if meta.is_symlink() {
                EntryKind::Symlink
            } else {
                EntryKind::File
            };
            out.push(RemoteDirEntry {
                name,
                kind,
                size: meta.size.unwrap_or(0),
                mtime: remote_mtime_millis(meta.mtime.unwrap_or(0)),
            });
        }

        // Dirs first, then case-insensitive by name. Cache the lowercased key so
        // to_lowercase() runs once per entry (n) instead of per comparison (n log n).
        out.sort_by_cached_key(|e| {
            let rank: u8 = match e.kind {
                EntryKind::Dir => 0,
                _ => 1,
            };
            (rank, e.name.to_lowercase())
        });
        Ok(out)
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpRead, error)
    })
}

/// Read a remote file for preview. Same caps/behavior as fs_read_file:
/// too-large → metadata only; non-UTF8 → binary; otherwise text (truncated to
/// the preview budget).
#[tauri::command]
pub async fn ssh_fs_read_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
) -> Result<RemoteReadResult, String> {
    (async {
        let sftp = sftp_for(&state, id).await?;

        let link_meta = await_stage(
            "lstat remote file",
            SFTP_CONTROL_TIMEOUT,
            sftp.symlink_metadata(&path),
        )
        .await?;
        let editable_regular = link_meta.is_regular() && !link_meta.is_symlink();
        let meta = await_stage(
            "stat remote file",
            SFTP_CONTROL_TIMEOUT,
            sftp.metadata(&path),
        )
        .await?;
        let size = meta.size.unwrap_or(0);
        if size > MAX_READ_BYTES {
            return Ok(RemoteReadResult::TooLarge {
                size,
                limit: MAX_READ_BYTES,
            });
        }

        // Stream only the UI preview budget. The old implementation buffered up
        // to 10 MiB before returning a 256 KiB slice, which made opening a large
        // remote log needlessly expensive before the user chose a bounded view.
        let mut file =
            await_stage("open remote file", SFTP_CONTROL_TIMEOUT, sftp.open(&path)).await?;
        let mut bytes: Vec<u8> = Vec::with_capacity(size.min(MAX_TEXT_PREVIEW_BYTES + 1) as usize);
        await_stage(
            "read remote file",
            SFTP_PREVIEW_TIMEOUT,
            (&mut file)
                .take(MAX_TEXT_PREVIEW_BYTES + 1)
                .read_to_end(&mut bytes),
        )
        .await?;

        let truncated =
            size > MAX_TEXT_PREVIEW_BYTES || bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES;
        if bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
            bytes.truncate(MAX_TEXT_PREVIEW_BYTES as usize);
        }

        if let Some(image) = crate::modules::fs::file::image_preview(&bytes) {
            if u64::from(image.width).saturating_mul(u64::from(image.height))
                > crate::modules::fs::file::MAX_IMAGE_PIXELS
            {
                return Ok(RemoteReadResult::ImageTooLarge {
                    size,
                    width: image.width,
                    height: image.height,
                    max_pixels: crate::modules::fs::file::MAX_IMAGE_PIXELS,
                });
            }
            // Raster previews intentionally need the complete payload, unlike
            // large text. Reopen after sniffing so the byte dropped by the
            // text-preview +1 probe cannot corrupt the image, and retain the
            // existing 10 MiB hard bound if remote metadata under-reported.
            let mut image_file =
                await_stage("open remote image", SFTP_CONTROL_TIMEOUT, sftp.open(&path)).await?;
            let mut image_bytes = Vec::with_capacity(size.min(MAX_READ_BYTES + 1) as usize);
            await_stage(
                "read remote image",
                SFTP_PREVIEW_TIMEOUT,
                (&mut image_file)
                    .take(MAX_READ_BYTES + 1)
                    .read_to_end(&mut image_bytes),
            )
            .await?;
            if image_bytes.len() as u64 > MAX_READ_BYTES {
                return Ok(RemoteReadResult::TooLarge {
                    size: image_bytes.len() as u64,
                    limit: MAX_READ_BYTES,
                });
            }
            return Ok(RemoteReadResult::Image {
                bytes: image_bytes,
                size,
                mime: image.mime,
                width: image.width,
                height: image.height,
            });
        }

        // Null-byte heuristic for binary detection, like the local reader.
        if bytes.contains(&0) {
            return Ok(RemoteReadResult::Binary { size });
        }
        match String::from_utf8(bytes) {
            Ok(content) => Ok(RemoteReadResult::Text {
                fingerprint: (editable_regular && !truncated && content.len() as u64 == size)
                    .then(|| content_fingerprint(content.as_bytes())),
                content,
                size,
                truncated,
            }),
            Err(error) if truncated && error.utf8_error().error_len().is_none() => {
                let valid = error.utf8_error().valid_up_to();
                let mut bytes = error.into_bytes();
                bytes.truncate(valid);
                Ok(RemoteReadResult::Text {
                    content: String::from_utf8(bytes).expect("valid UTF-8 prefix"),
                    size,
                    truncated: true,
                    fingerprint: None,
                })
            }
            Err(_) => Ok(RemoteReadResult::Binary { size }),
        }
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpRead, error)
    })
}

/// Read only the first requested lines through the current, fully validated
/// SSH binding. Both the line count and buffered bytes have backend hard caps.
#[tauri::command]
pub async fn ssh_file_view_head_v1(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
    line_limit: u32,
    request_id: String,
) -> Result<FileHeadResultV1, FileViewErrorV1> {
    validate_line_limit(line_limit)?;
    let registration = RequestRegistration::register(request_id)?;
    let sftp = super::sftp_common::session_for_binding(state.inner(), &binding)
        .await
        .map_err(|_| FileViewErrorV1::stale_binding())?;
    let before = await_stage(
        "stat bounded remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    if !before.is_regular() {
        return Err(FileViewErrorV1::read_failed());
    }
    let size = before.size.unwrap_or(0);
    let before_revision = remote_revision(size, before.mtime);
    let mut file = await_stage(
        "open bounded remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    let mut accumulator = HeadAccumulator::new();
    let mut chunk = [0_u8; HEAD_CHUNK_BYTES];
    let reached_eof = tokio::time::timeout(SFTP_PREVIEW_TIMEOUT, async {
        loop {
            if registration.cancelled.load(Ordering::Acquire) {
                return Err(FileViewErrorV1::cancelled());
            }
            let count = tokio::time::timeout(SFTP_CHUNK_TIMEOUT, file.read(&mut chunk))
                .await
                .map_err(|_| FileViewErrorV1::read_failed())?
                .map_err(|error| remote_file_view_error(&error.to_string()))?;
            if count == 0 {
                break Ok(true);
            }
            accumulator.push(&chunk[..count], line_limit);
            if accumulator.is_complete() {
                break Ok(false);
            }
        }
    })
    .await
    .map_err(|_| FileViewErrorV1::read_failed())??;
    if registration.cancelled.load(Ordering::Acquire) {
        return Err(FileViewErrorV1::cancelled());
    }
    let after = await_stage(
        "restat bounded remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|_| FileViewErrorV1::changed())?;
    let after_size = after.size.unwrap_or(0);
    let after_revision = remote_revision(after_size, after.mtime);
    if before_revision != after_revision {
        return Err(FileViewErrorV1::changed());
    }
    Ok(accumulator.finish(size, before_revision, line_limit, reached_eof))
}

/// Read only the last requested lines through the current SSH binding.
#[tauri::command]
pub async fn ssh_file_view_tail_v1(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
    line_limit: u32,
    request_id: String,
) -> Result<FileHeadResultV1, FileViewErrorV1> {
    validate_line_limit(line_limit)?;
    let registration = RequestRegistration::register(request_id)?;
    let sftp = super::sftp_common::session_for_binding(state.inner(), &binding)
        .await
        .map_err(|_| FileViewErrorV1::stale_binding())?;
    let before = await_stage(
        "stat bounded remote tail",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    if !before.is_regular() {
        return Err(FileViewErrorV1::read_failed());
    }
    let size = before.size.unwrap_or(0);
    let before_revision = remote_revision(size, before.mtime);
    let offset = size.saturating_sub(MAX_HEAD_BYTES as u64);
    let mut file = await_stage(
        "open bounded remote tail",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(&path),
    )
    .await
    .map_err(|error| remote_file_view_error(&error))?;
    if offset > 0 {
        tokio::time::timeout(
            SFTP_CONTROL_TIMEOUT,
            file.seek(std::io::SeekFrom::Start(offset)),
        )
        .await
        .map_err(|_| FileViewErrorV1::read_failed())?
        .map_err(|_| FileViewErrorV1::read_failed())?;
    }
    let mut bytes = Vec::with_capacity((size - offset).min(MAX_HEAD_BYTES as u64) as usize);
    let mut chunk = [0_u8; HEAD_CHUNK_BYTES];
    tokio::time::timeout(SFTP_PREVIEW_TIMEOUT, async {
        loop {
            if registration.cancelled.load(Ordering::Acquire) {
                return Err(FileViewErrorV1::cancelled());
            }
            let count = tokio::time::timeout(SFTP_CHUNK_TIMEOUT, file.read(&mut chunk))
                .await
                .map_err(|_| FileViewErrorV1::read_failed())?
                .map_err(|error| remote_file_view_error(&error.to_string()))?;
            if count == 0 {
                break Ok(());
            }
            let remaining = MAX_HEAD_BYTES.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..count.min(remaining)]);
            if bytes.len() == MAX_HEAD_BYTES {
                break Ok(());
            }
        }
    })
    .await
    .map_err(|_| FileViewErrorV1::read_failed())??;
    if registration.cancelled.load(Ordering::Acquire) {
        return Err(FileViewErrorV1::cancelled());
    }
    let after = await_stage(
        "restat bounded remote tail",
        SFTP_CONTROL_TIMEOUT,
        sftp.metadata(&path),
    )
    .await
    .map_err(|_| FileViewErrorV1::changed())?;
    let after_revision = remote_revision(after.size.unwrap_or(0), after.mtime);
    if before_revision != after_revision {
        return Err(FileViewErrorV1::changed());
    }
    Ok(finish_tail(
        bytes,
        size,
        before_revision,
        line_limit,
        offset > 0,
    ))
}

fn remote_file_view_error(raw: &str) -> FileViewErrorV1 {
    if raw.to_ascii_lowercase().contains("permission") {
        FileViewErrorV1::permission_denied()
    } else {
        FileViewErrorV1::read_failed()
    }
}

async fn read_remote_editable_bytes(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(Vec<u8>, u32), String> {
    validate_remote_edit_path(path)?;
    let metadata = await_stage(
        "lstat editable remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.symlink_metadata(path),
    )
    .await?;
    if metadata.is_symlink() || !metadata.is_regular() {
        return Err("editable path must be a regular file".into());
    }
    if metadata.size.unwrap_or(0) > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable file exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    let mode = metadata
        .permissions
        .ok_or_else(|| "remote server did not report file permissions".to_string())?
        & 0o7777;
    let mut file = await_stage(
        "open editable remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(path),
    )
    .await?;
    let mut bytes = Vec::with_capacity(metadata.size.unwrap_or(0) as usize);
    await_stage(
        "read editable remote file",
        SFTP_PREVIEW_TIMEOUT,
        (&mut file)
            .take(MAX_TEXT_PREVIEW_BYTES + 1)
            .read_to_end(&mut bytes),
    )
    .await?;
    if bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable file exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) || std::str::from_utf8(&bytes).is_err() {
        return Err("editable file must be UTF-8 text".into());
    }
    Ok((bytes, mode))
}

/// Conflict-safe remote text save. SFTP prepares a create-new sibling with the
/// original mode and drains all write acknowledgements. The final `mv` runs on
/// the same SSH connection because russh-sftp 2.3 does not expose OpenSSH's
/// posix-rename extension; on the supported Unix hosts, same-directory `mv`
/// delegates to atomic rename without ever removing the destination first.
#[tauri::command]
pub async fn ssh_fs_write_text_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
    content: String,
    expected_fingerprint: String,
) -> Result<crate::modules::fs::file::WriteResult, String> {
    (async {
    if content.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable content exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    validate_fingerprint(&expected_fingerprint)?;
    validate_remote_edit_path(&path)?;
    // Serialize saves issued by this app for the same remote path. The second
    // caller must re-read after the first commits and report a conflict instead
    // of letting two equal fingerprints both pass the pre-rename check.
    let write_lock = remote_write_lock(id, &path);
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err("not a remote session".into()),
    };
    let sftp = ssh.sftp().await?;
    let adapter = SftpWriteAdapter::new(&sftp, ssh, id);
    let mut outcome = None;
    for attempt in 0..16 {
        let temporary = remote_sibling_temp_path(&path, attempt)?;
        match write_text_transaction(
            &adapter,
            write_lock.as_ref(),
            WriteRequest {
                target: &path,
                temporary: &temporary,
                content: content.as_bytes(),
                expected_fingerprint: &expected_fingerprint,
            },
        )
        .await
        {
            Err(error)
                if error.stage == TransactionStage::Create
                    && error.source.to_ascii_lowercase().contains("exist") =>
            {
                continue;
            }
            result => {
                outcome = Some(result);
                break;
            }
        }
    }
    let outcome = outcome
        .ok_or_else(|| "could not allocate remote temporary file after 16 attempts".to_string())?
        .map_err(|error| error.to_string())?;
    match outcome {
        TransactionOutcome::Saved { fingerprint, size } => {
            Ok(crate::modules::fs::file::WriteResult::Saved { fingerprint, size })
        }
        TransactionOutcome::Conflict { current_fingerprint, .. } => {
            Ok(crate::modules::fs::file::WriteResult::Conflict { current_fingerprint })
        }
        TransactionOutcome::OutcomeUnknown {
            attempted_fingerprint,
            expected_mode,
            replace_lock_owner,
            cleanup_pending,
        } => Err(format!(
            "outcomeUnknown:{attempted_fingerprint}:{expected_mode:o}:lockOwner={replace_lock_owner}:cleanupPending={cleanup_pending}"
        )),
    }

    }).await.map_err(|error: String| crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpWrite, error))
}

struct SftpWriteAdapter<'a> {
    sftp: &'a russh_sftp::client::SftpSession,
    ssh: &'a super::connection::SshSession,
    #[cfg(feature = "m2-safe-write-benchmark")]
    session_id: u32,
    #[cfg(test)]
    replace_request_hook: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    replace_response_delay: Option<Duration>,
}

impl<'a> SftpWriteAdapter<'a> {
    fn new(
        sftp: &'a russh_sftp::client::SftpSession,
        ssh: &'a super::connection::SshSession,
        #[cfg_attr(not(feature = "m2-safe-write-benchmark"), allow(unused_variables))]
        session_id: u32,
    ) -> Self {
        Self {
            sftp,
            ssh,
            #[cfg(feature = "m2-safe-write-benchmark")]
            session_id,
            #[cfg(test)]
            replace_request_hook: None,
            #[cfg(test)]
            replace_response_delay: None,
        }
    }

    #[cfg(test)]
    fn with_replace_test_probe(
        mut self,
        hook: Arc<dyn Fn() + Send + Sync>,
        response_delay: Duration,
    ) -> Self {
        self.replace_request_hook = Some(hook);
        self.replace_response_delay = Some(response_delay);
        self
    }
}

impl RemoteWriteIo for SftpWriteAdapter<'_> {
    type Temp = russh_sftp::client::fs::File;

    async fn read_regular(&self, path: &str) -> Result<RemoteFile, IoError> {
        read_remote_editable_bytes(self.sftp, path)
            .await
            .map(|(bytes, mode)| RemoteFile {
                bytes,
                mode,
                kind: RemoteFileKind::Regular,
            })
            .map_err(IoError)
    }

    async fn create_exclusive(&self, path: &str, mode: u32) -> Result<Self::Temp, IoError> {
        await_stage(
            "create remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            self.sftp.open_with_flags_and_attributes(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(mode),
                    ..FileAttributes::empty()
                },
            ),
        )
        .await
        .map_err(IoError)
    }

    async fn write_all(&self, temporary: &mut Self::Temp, bytes: &[u8]) -> Result<(), IoError> {
        await_stage(
            "write remote temporary file",
            SFTP_WRITE_TIMEOUT,
            temporary.write_all(bytes),
        )
        .await
        .map_err(IoError)
    }
    async fn flush(&self, temporary: &mut Self::Temp) -> Result<(), IoError> {
        await_stage(
            "flush remote temporary file",
            SFTP_WRITE_TIMEOUT,
            temporary.flush(),
        )
        .await
        .map_err(IoError)
    }
    async fn set_mode(&self, temporary: &mut Self::Temp, mode: u32) -> Result<(), IoError> {
        await_stage(
            "set remote temporary permissions",
            SFTP_CONTROL_TIMEOUT,
            temporary.set_metadata(FileAttributes {
                permissions: Some(mode),
                ..FileAttributes::empty()
            }),
        )
        .await
        .map_err(IoError)
    }
    async fn sync(&self, temporary: &mut Self::Temp) -> Result<(), IoError> {
        await_stage(
            "sync remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            temporary.sync_all(),
        )
        .await
        .map_err(IoError)
    }
    async fn close(&self, mut temporary: Self::Temp) -> Result<(), IoError> {
        await_stage(
            "close remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            temporary.shutdown(),
        )
        .await
        .map_err(IoError)
    }
    async fn acquire_replace_lock(&self, target: &str, owner: &str) -> Result<(), IoError> {
        validate_fingerprint(owner).map_err(IoError)?;
        let lock = remote_replace_lock_path(target).map_err(IoError)?;
        let owner_path = remote_replace_lock_owner_path(target).map_err(IoError)?;
        let deadline = tokio::time::Instant::now() + SFTP_CONTROL_TIMEOUT;
        let mut stale_checked = false;
        loop {
            match self.sftp.create_dir(lock.clone()).await {
                Ok(()) => {
                    let result = async {
                        let mut marker = self
                            .sftp
                            .open_with_flags_and_attributes(
                                owner_path.clone(),
                                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                                FileAttributes {
                                    permissions: Some(0o600),
                                    ..FileAttributes::empty()
                                },
                            )
                            .await
                            .map_err(|error| IoError(error.to_string()))?;
                        marker
                            .write_all(owner.as_bytes())
                            .await
                            .map_err(|error| IoError(error.to_string()))?;
                        marker
                            .shutdown()
                            .await
                            .map_err(|error| IoError(error.to_string()))
                    }
                    .await;
                    if let Err(error) = result {
                        let _ = self.sftp.remove_file(owner_path.clone()).await;
                        let _ = self.sftp.remove_dir(lock.clone()).await;
                        return Err(error);
                    }
                    return Ok(());
                }
                Err(source) => {
                    let message = source.to_string();
                    let lower = message.to_ascii_lowercase();
                    if lower.contains("permission")
                        || lower.contains("denied")
                        || lower.contains("no such")
                    {
                        return Err(IoError(format!(
                            "acquire remote replace lock failed: {message}"
                        )));
                    }
                    if !stale_checked {
                        stale_checked = true;
                        let age_seconds = self
                            .sftp
                            .metadata(lock.clone())
                            .await
                            .ok()
                            .and_then(|metadata| metadata.mtime)
                            .and_then(|mtime| {
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .ok()
                                    .map(|now| now.as_secs().saturating_sub(u64::from(mtime)))
                            });
                        if let Some(age_seconds) =
                            age_seconds.filter(|age| *age >= REPLACE_LOCK_STALE_AFTER.as_secs())
                        {
                            // A stat/delete/recreate sequence cannot compare a
                            // lock generation atomically over portable SFTP. An
                            // active writer could replace the directory after
                            // our stat and then have its new lock deleted here.
                            // Fail closed and leave owner-aware reconciliation
                            // (or explicit operator cleanup) as the recovery
                            // path instead of risking two successful writers.
                            let owner = tokio::time::timeout(
                                SFTP_CONTROL_TIMEOUT,
                                read_remote_replace_lock_owner(self.sftp, target),
                            )
                            .await
                            .ok()
                            .and_then(Result::ok);
                            return Err(stale_replace_lock_error(
                                &lock,
                                age_seconds,
                                owner.as_deref(),
                            ));
                        }
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(IoError(format!(
                            "remote replace lock stayed busy for {}s: {message}",
                            SFTP_CONTROL_TIMEOUT.as_secs()
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
            }
        }
    }
    async fn release_replace_lock(&self, target: &str, owner: &str) -> Result<(), IoError> {
        validate_fingerprint(owner).map_err(IoError)?;
        #[cfg(feature = "m2-safe-write-benchmark")]
        if super::m2_safe_write_benchmark::take_release_failure(self.session_id, target) {
            return Err(IoError(
                "isolated M2 benchmark injected a one-shot release failure".into(),
            ));
        }
        let lock = remote_replace_lock_path(target).map_err(IoError)?;
        let owner_path = remote_replace_lock_owner_path(target).map_err(IoError)?;
        let observed = read_remote_replace_lock_owner(self.sftp, target).await?;
        if observed != owner {
            return Err(IoError("remote replace lock owner changed".into()));
        }
        await_stage(
            "remove remote replace lock owner",
            SFTP_CONTROL_TIMEOUT,
            self.sftp.remove_file(owner_path),
        )
        .await
        .map_err(IoError)?;
        await_stage(
            "release remote replace lock",
            SFTP_CONTROL_TIMEOUT,
            self.sftp.remove_dir(lock),
        )
        .await
        .map_err(IoError)
    }
    async fn atomic_replace(&self, temporary: &str, target: &str) -> Result<(), ReplaceError> {
        let command = format!(
            "mv -f -- {} {}",
            shell_quote(temporary),
            shell_quote(target)
        );
        #[cfg(test)]
        let command = self
            .replace_response_delay
            .map(|delay| format!("{command} && sleep {}", delay.as_secs()))
            .unwrap_or(command);
        #[cfg(test)]
        if let Some(hook) = self.replace_request_hook.as_deref() {
            return self
                .ssh
                .exec_with_test_request_hook(&command, 16 * 1024, hook)
                .await
                .map(|_| ())
                .map_err(ReplaceError::StatusLost);
        }
        self.ssh
            .exec(&command, 16 * 1024)
            .await
            .map(|_| ())
            .map_err(ReplaceError::StatusLost)
    }
    async fn remove_temp(&self, path: &str) -> Result<(), IoError> {
        await_stage(
            "remove remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            self.sftp.remove_file(path),
        )
        .await
        .map_err(IoError)
    }
}

async fn cleanup_owned_write_residue(
    sftp: &russh_sftp::client::SftpSession,
    target: &str,
    owner: &str,
) -> Result<(), String> {
    validate_fingerprint(owner)?;
    let (parsed, name) = validate_remote_edit_path(target)?;
    let parent = parsed
        .parent()
        .ok_or_else(|| "editable path has no parent".to_string())?;
    let prefix = format!(".{name}.tunara-");
    let entries = await_stage(
        "list remote write residue",
        SFTP_CONTROL_TIMEOUT,
        sftp.read_dir(parent.to_string_lossy().into_owned()),
    )
    .await?;
    for entry in entries {
        let file_name = entry.file_name();
        if file_name.starts_with(&prefix)
            && file_name.ends_with(".tmp")
            && content_fingerprint(entry.path().as_bytes()) == owner
        {
            await_stage(
                "remove owned remote temporary file",
                SFTP_CONTROL_TIMEOUT,
                sftp.remove_file(entry.path()),
            )
            .await?;
        }
    }

    let lock = remote_replace_lock_path(target)?;
    if sftp.metadata(lock.clone()).await.is_ok() {
        let observed_owner = read_remote_replace_lock_owner(sftp, target)
            .await
            .map_err(|error| error.0)?;
        if observed_owner != owner {
            return Err("remote replace lock belongs to another transaction".into());
        }
        let owner_path = remote_replace_lock_owner_path(target)?;
        await_stage(
            "remove owned remote replace lock marker",
            SFTP_CONTROL_TIMEOUT,
            sftp.remove_file(owner_path),
        )
        .await?;
        await_stage(
            "remove owned remote replace lock",
            SFTP_CONTROL_TIMEOUT,
            sftp.remove_dir(lock),
        )
        .await?;
    }
    Ok(())
}

/// Reconcile an indeterminate replace after reconnect. Bytes alone are not
/// sufficient: permission preservation is part of the save contract, so the
/// caller must return the mode encoded in the outcomeUnknown token.
#[tauri::command]
pub async fn ssh_fs_reconcile_text_write(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
    attempted_fingerprint: String,
    expected_mode: u32,
    replace_lock_owner: String,
) -> Result<crate::modules::fs::file::WriteResult, String> {
    (async {
        let sftp = sftp_for(&state, id).await?;
        reconcile_text_write_with_sftp(
            &sftp,
            &path,
            &attempted_fingerprint,
            expected_mode,
            &replace_lock_owner,
        )
        .await
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpWrite, error)
    })
}

async fn reconcile_text_write_with_sftp(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    attempted_fingerprint: &str,
    expected_mode: u32,
    replace_lock_owner: &str,
) -> Result<crate::modules::fs::file::WriteResult, String> {
    validate_fingerprint(attempted_fingerprint)?;
    validate_fingerprint(replace_lock_owner)?;
    validate_remote_edit_path(path)?;
    if expected_mode > 0o7777 {
        return Err("reconcile mode must fit Unix permission bits".into());
    }
    let (observed, observed_mode) = read_remote_editable_bytes(sftp, path).await?;
    let current_fingerprint = content_fingerprint(&observed);
    let result = if current_fingerprint == attempted_fingerprint && observed_mode == expected_mode {
        Ok(crate::modules::fs::file::WriteResult::Saved {
            fingerprint: current_fingerprint,
            size: observed.len() as u64,
        })
    } else {
        Ok(crate::modules::fs::file::WriteResult::Conflict {
            current_fingerprint,
        })
    };
    cleanup_owned_write_residue(sftp, path, replace_lock_owner).await?;
    result
}

// Cap a single download so a malicious/compromised remote can't exhaust memory
// (whole file is buffered before writing). 100 MiB is generous for a file
// browser's download affordance.
pub(crate) const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// Validate the caller-supplied local destination. The remote fully controls
/// the downloaded bytes, so an unvetted `local_path` would let a compromised
/// SSH server write attacker content to e.g. ~/.zshrc or ~/.ssh/authorized_keys
/// (local code execution / persistence). We require: an absolute path inside
/// the user's home, not under sensitive dotfile dirs, not a home-root shell/login
/// rc file (`~/.zshrc` etc.), and no overwrite.
///
/// The confinement is enforced on the *canonicalized* parent directory, not on
/// the literal string. `Path::starts_with` is a component-wise prefix test, so
/// `~/../../etc/x` literally still "starts with" home yet resolves outside it;
/// and a symlinked subdir (e.g. `~/Downloads -> /Volumes/ext`) would let bytes
/// escape home. Canonicalizing the parent collapses `..` and resolves symlinks,
/// so the prefix test runs against the real on-disk location.
pub(crate) fn validate_download_target(local_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(local_path);
    if !path.is_absolute() {
        return Err("download path must be absolute".into());
    }
    // Defense-in-depth: reject any `..` outright before resolving, so a path
    // that escapes via parent traversal never even reaches canonicalize.
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("download path must not contain '..'".into());
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| "download path must name a file".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "download path must have a parent directory".to_string())?;

    // Canonicalize the parent (it must already exist — we never create dirs) and
    // home, so the prefix check compares real, symlink-resolved locations.
    let real_parent = std::fs::canonicalize(parent)
        .map_err(|_| "download directory does not exist".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    let real_home = std::fs::canonicalize(&home).unwrap_or(home);

    if !real_parent.starts_with(&real_home) {
        return Err("download path must be under the home directory".into());
    }
    // Reject sensitive locations even within home (compared post-resolution).
    // Canonicalize the needle too: `real_parent` is symlink-resolved, so a
    // symlinked ~/.config -> ~/.dotfiles/config would otherwise slip past a
    // raw `real_home.join(".config")` prefix test and let remote-controlled
    // bytes land in the real config/ssh/gnupg dir (blocklist fail-open).
    for sensitive in [".ssh", ".config", ".gnupg"] {
        let needle = real_home.join(sensitive);
        let real_needle = std::fs::canonicalize(&needle).unwrap_or(needle);
        if real_parent.starts_with(&real_needle) {
            return Err(format!("refusing to write into ~/{sensitive}"));
        }
    }
    // The directory blocklist above is scoped to subdirs, so it does NOT cover a
    // shell/login rc file written directly to the home ROOT (`~/.zshrc`,
    // `~/.zshenv`, `~/.bashrc`, `~/.profile`, …) — whose parent IS home and thus
    // passes every check above. Those files are auto-sourced on the next
    // interactive/login shell, so a remote-controlled write to one is code
    // execution / persistence — the exact `~/.zshrc` threat this function's
    // docstring names. create_new only blocks OVERWRITE; rc files that don't yet
    // exist (commonly `~/.zshenv`/`~/.zprofile` on a default macOS account) would
    // otherwise be created fresh. Reject them when the parent is the home root.
    if real_parent == real_home {
        // Auto-sourced shell/login startup files across sh/bash/zsh/csh/ksh +
        // readline. Match case-insensitively so `.ZSHRC` can't slip past on a
        // case-insensitive filesystem (the default on macOS).
        const RC_FILES: [&str; 17] = [
            ".zshrc",
            ".zshenv",
            ".zprofile",
            ".zlogin",
            ".zlogout",
            ".bashrc",
            ".bash_profile",
            ".bash_login",
            ".bash_logout",
            ".profile",
            ".kshrc",
            ".cshrc",
            ".tcshrc",
            ".login",
            ".logout",
            ".inputrc",
            ".bash_aliases",
        ];
        let name = file_name.to_string_lossy().to_ascii_lowercase();
        if RC_FILES.contains(&name.as_str()) {
            return Err(format!(
                "refusing to write shell startup file ~/{}",
                file_name.to_string_lossy()
            ));
        }
    }

    let target = real_parent.join(file_name);
    // UX guard: refuse an existing destination so a download doesn't silently
    // clobber. The write itself uses create_new (see legacy_download_file) so the
    // no-overwrite guarantee is atomic; this is just an earlier friendly error.
    if target.exists() {
        return Err("destination already exists".into());
    }
    Ok(target)
}

/// Create missing parent directories for a download, but only when the first
/// existing ancestor is already inside the home confinement used by
/// [`validate_download_target`].
pub(crate) fn ensure_download_parents(local_path: &str) -> Result<(), String> {
    let path = std::path::Path::new(local_path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("download path must be absolute and must not contain '..'".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "download path must have a parent directory".to_string())?;
    if parent.exists() {
        return Ok(());
    }
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    let real_home = std::fs::canonicalize(&home).unwrap_or(home);
    let mut cursor = parent;
    while !cursor.exists() {
        cursor = cursor
            .parent()
            .ok_or_else(|| "download directory does not exist".to_string())?;
    }
    let real_existing = std::fs::canonicalize(cursor)
        .map_err(|_| "download directory does not exist".to_string())?;
    if !real_existing.starts_with(&real_home) {
        return Err("download path must be under the home directory".into());
    }
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create download directory failed: {error}"))?;
    Ok(())
}

/// Download a remote file to a local path. The destination is validated to a
/// safe location (see `validate_download_target`) because the bytes are
/// remote-controlled. Streamed chunk-by-chunk (O(chunk) memory) and aborted
/// once a byte counter exceeds MAX_DOWNLOAD_BYTES.
pub(crate) async fn legacy_download_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let target = validate_download_target(&local_path)?;
    let sftp = sftp_for(&state, id).await?;

    // Open both ends first. create_new makes the no-overwrite guarantee atomic,
    // closing the gap between validate_download_target's exists() check and this
    // write.
    let mut remote = await_stage(
        "open remote download",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(&remote_path),
    )
    .await?;
    let mut local = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => "destination already exists".to_string(),
            _ => format!("write local file failed: {e}"),
        })?;

    // Stream chunk-by-chunk so memory stays O(chunk), and enforce the cap with
    // an authoritative byte COUNTER rather than the server-controlled stat size.
    // The previous code gated on `metadata().size`, which a compromised server
    // can under-report (or which is simply skipped when metadata() errors), and
    // only checked the real length after the whole file was already resident —
    // a remote-driven memory-exhaustion hole. The counter below is the only
    // thing the size limit trusts.
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    // Any early exit from here on must delete the partial file: the local file
    // was already created with create_new, so a mid-stream failure (remote read
    // error, cap exceeded, local write, or final flush) would otherwise leave a
    // truncated artifact — breaking the "a refused/aborted download leaves no
    // truncated artifact behind" invariant and blocking a same-path retry with
    // "destination already exists". `cleanup_partial` drops the handle and
    // removes the file so every failure arm shares one honest exit.
    async fn cleanup_partial(local: tokio::fs::File, target: &std::path::Path) {
        drop(local);
        let _ = tokio::fs::remove_file(target).await;
    }
    loop {
        let n = match await_stage(
            "read remote download chunk",
            SFTP_CHUNK_TIMEOUT,
            remote.read(&mut buf),
        )
        .await
        {
            Ok(n) => n,
            Err(e) => {
                cleanup_partial(local, &target).await;
                return Err(e);
            }
        };
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > MAX_DOWNLOAD_BYTES {
            cleanup_partial(local, &target).await;
            return Err(format!(
                "remote file exceeds download limit ({} MiB)",
                MAX_DOWNLOAD_BYTES / (1024 * 1024)
            ));
        }
        if let Err(e) = local.write_all(&buf[..n]).await {
            cleanup_partial(local, &target).await;
            return Err(format!("write local file failed: {e}"));
        }
    }
    if let Err(e) = local.flush().await {
        cleanup_partial(local, &target).await;
        return Err(format!("write local file failed: {e}"));
    }
    Ok(written)
}

/// Cancel an active upload. The transfer loop checks the flag before each
/// local read and remote write, then removes its partial remote file.
pub(crate) fn cancel_upload(transfer_id: String) -> bool {
    let Some(table) = UPLOAD_CANCELLATIONS.get() else {
        return false;
    };
    let table = table
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(cancelled) = table.get(&transfer_id) else {
        return false;
    };
    cancelled.store(true, Ordering::Release);
    true
}

/// Upload one user-selected regular local file to an absolute remote path.
/// New files use SFTP EXCLUDE for atomic no-overwrite behavior. Explicit
/// replacements are streamed to a hidden sibling and committed with OpenSSH's
/// posix-rename SFTP extension. It is supported by OpenSSH on Linux/macOS/BSD,
/// avoids login-shell and GNU `mv` assumptions, and cannot move the temporary
/// file inside a directory racing into the destination pathname. We fail before
/// transfer when that safe primitive is unavailable. Cancellation and I/O
/// failures never truncate the existing destination,
/// and a racing directory cannot capture the temporary file as a child.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    transfer_id: String,
    local_path: String,
    opened_source: Option<std::fs::File>,
    remote_path: String,
    overwrite: bool,
    mode: UploadMode,
    mut on_progress: impl FnMut(UploadProgress),
    external_cancel: Option<Arc<AtomicBool>>,
    mut on_allocated: impl FnMut(&str, u64) -> Result<(), String>,
    mut on_checkpoint: impl FnMut(&str, u64, String) -> Result<(), String>,
    mut on_commit: impl FnMut(String) -> Result<Option<crate::modules::pty::CommitLease>, String>,
    resume: Option<(String, u64)>,
) -> Result<u64, String> {
    let registration = UploadRegistration::register(&transfer_id)?;
    validate_remote_edit_path(&remote_path)?;
    let local = Path::new(&local_path);
    if !local.is_absolute() {
        return Err("upload source path must be absolute".into());
    }
    if local
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("upload source path must not contain '..'".into());
    }
    let path_metadata = if opened_source.is_none() {
        let metadata = tokio::fs::symlink_metadata(local)
            .await
            .map_err(|error| format!("read upload source metadata failed: {error}"))?;
        if !metadata.file_type().is_file() {
            return Err("upload source must be a regular file (symlinks are not followed)".into());
        }
        Some(metadata)
    } else {
        None
    };
    let mut source = match opened_source {
        Some(file) => tokio::fs::File::from_std(file),
        None => tokio::fs::File::open(local)
            .await
            .map_err(|error| format!("open upload source failed: {error}"))?,
    };
    let opened_metadata = source
        .metadata()
        .await
        .map_err(|error| format!("read opened upload source metadata failed: {error}"))?;
    if !opened_metadata.is_file() {
        return Err("opened upload source is not a regular file".into());
    }
    #[cfg(unix)]
    if let Some(path_metadata) = path_metadata {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != opened_metadata.dev()
            || path_metadata.ino() != opened_metadata.ino()
        {
            return Err("upload source changed while it was being opened".into());
        }
    }
    #[cfg(not(unix))]
    let _ = path_metadata;
    let total = opened_metadata.len();

    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err("not a remote session".into()),
    };
    let sftp = ssh.sftp().await?;

    let replacement_mode = if overwrite {
        if !ssh.supports_sftp_posix_rename().await? {
            return Err(
                "remote SFTP server does not support safe atomic overwrite; upload with a new name"
                    .into(),
            );
        }
        Some(validate_upload_replace_target(&sftp, &remote_path).await?)
    } else {
        None
    };

    let upload_path = if let Some((partial, offset)) = resume.clone() {
        use tokio::io::AsyncSeekExt;
        if offset > total {
            return Err("upload resume offset exceeds source length".into());
        }
        source
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| format!("seek upload source for resume failed: {error}"))?;
        let mut file = await_stage(
            "open remote upload partial for resume",
            SFTP_CONTROL_TIMEOUT,
            sftp.open_with_flags(partial.clone(), OpenFlags::WRITE),
        )
        .await?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| format!("seek remote upload partial failed: {error}"))?;
        (partial, file)
    } else if overwrite {
        let mut temporary = None;
        for attempt in 0..16 {
            let candidate = remote_sibling_temp_path(&remote_path, attempt)?;
            match await_stage(
                "create remote upload temporary file",
                SFTP_CONTROL_TIMEOUT,
                sftp.open_with_flags_and_attributes(
                    candidate.clone(),
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                    FileAttributes {
                        permissions: Some(0o600),
                        ..FileAttributes::empty()
                    },
                ),
            )
            .await
            {
                Ok(file) => {
                    temporary = Some((candidate, file));
                    break;
                }
                Err(error) if error.to_ascii_lowercase().contains("exist") => continue,
                Err(error) => return Err(error),
            }
        }
        temporary.ok_or_else(|| {
            "could not allocate remote upload temporary file after 16 attempts".to_string()
        })?
    } else {
        if await_stage(
            "check remote upload destination",
            SFTP_CONTROL_TIMEOUT,
            sftp.symlink_metadata(&remote_path),
        )
        .await
        .is_ok()
        {
            return Err("remote destination already exists".into());
        }
        let file = await_stage(
            "create remote upload destination",
            SFTP_CONTROL_TIMEOUT,
            sftp.open_with_flags_and_attributes(
                remote_path.clone(),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..FileAttributes::empty()
                },
            ),
        )
        .await
        .map_err(|error| {
            if error.to_ascii_lowercase().contains("exist") {
                "remote destination already exists".to_string()
            } else {
                error
            }
        })?;
        (remote_path.clone(), file)
    };
    let (partial_path, mut destination) = upload_path;
    let resume_offset = resume.as_ref().map(|(_, offset)| *offset).unwrap_or(0);
    if let Err(error) = on_allocated(&partial_path, total) {
        return Err(encode_upload_error(
            "failed",
            &format!("upload journal allocation failed: {error}"),
            Some(&partial_path),
        ));
    }
    on_progress(UploadProgress {
        transferred: resume_offset,
        total,
    });
    let mut transferred = resume_offset;
    let mut content_hash = Sha256::new();
    if resume_offset > 0 {
        let mut prefix = tokio::fs::File::open(local)
            .await
            .map_err(|error| format!("rehash upload prefix failed: {error}"))?;
        let mut hashed = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        while hashed < resume_offset {
            let want = std::cmp::min(buffer.len() as u64, resume_offset - hashed) as usize;
            let count = prefix
                .read(&mut buffer[..want])
                .await
                .map_err(|error| format!("rehash upload prefix failed: {error}"))?;
            if count == 0 {
                return Err("upload source ended before resume offset".into());
            }
            content_hash.update(&buffer[..count]);
            hashed += count as u64;
        }
    }
    let mut buffer = vec![0_u8; 64 * 1024];

    let transfer_result: Result<(), String> = async {
        loop {
            if registration.cancelled.load(Ordering::Acquire)
                || external_cancel
                    .as_ref()
                    .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
            {
                return Err("upload cancelled".into());
            }
            let count = source
                .read(&mut buffer)
                .await
                .map_err(|error| format!("read upload source failed: {error}"))?;
            if count == 0 {
                break;
            }
            await_stage(
                "write remote upload chunk",
                SFTP_CHUNK_TIMEOUT,
                destination.write_all(&buffer[..count]),
            )
            .await?;
            transferred = transferred.saturating_add(count as u64);
            content_hash.update(&buffer[..count]);
            on_checkpoint(
                &partial_path,
                transferred,
                format!("{:x}", content_hash.clone().finalize()),
            )?;
            on_progress(UploadProgress { transferred, total });
        }
        if let Some(initial_mode) = replacement_mode {
            let final_mode = validate_upload_replace_target(&sftp, &remote_path).await?;
            let preserved_mode = preserved_upload_mode(initial_mode, final_mode)?;
            await_stage(
                "preserve remote upload replacement permissions",
                SFTP_CONTROL_TIMEOUT,
                destination.set_metadata(FileAttributes {
                    permissions: Some(preserved_mode),
                    ..FileAttributes::empty()
                }),
            )
            .await?;
        }
        await_stage(
            "finish remote upload",
            SFTP_CHUNK_TIMEOUT,
            destination.shutdown(),
        )
        .await?;
        if registration.cancelled.load(Ordering::Acquire)
            || external_cancel
                .as_ref()
                .is_some_and(|cancelled| cancelled.load(Ordering::Acquire))
        {
            return Err("upload cancelled".into());
        }
        Ok(())
    }
    .await;

    drop(destination);
    if let Err(error) = transfer_result {
        return Err(upload_residue_error(&partial_path, error));
    }
    let final_hash = format!("{:x}", content_hash.finalize());
    if overwrite && mode == UploadMode::Journaled {
        // Mandatory full SFTP readback proves the server-side partial bytes
        // before any rename mutation is attempted.
        let mut readback = await_stage(
            "open remote upload readback",
            SFTP_CONTROL_TIMEOUT,
            sftp.open(&partial_path),
        )
        .await?;
        let mut remote_hash = Sha256::new();
        let mut remote_bytes = 0_u64;
        loop {
            let count = await_stage(
                "read remote upload readback",
                SFTP_CHUNK_TIMEOUT,
                readback.read(&mut buffer),
            )
            .await?;
            if count == 0 {
                break;
            }
            remote_bytes = remote_bytes.saturating_add(count as u64);
            if remote_bytes > transferred {
                return Err(upload_residue_error(
                    &partial_path,
                    "remote upload readback exceeded expected size".into(),
                ));
            }
            remote_hash.update(&buffer[..count]);
        }
        if remote_bytes != transferred || format!("{:x}", remote_hash.finalize()) != final_hash {
            return Err(upload_residue_error(
                &partial_path,
                "remote upload readback SHA-256 mismatch".into(),
            ));
        }
    }
    if overwrite {
        let _commit_lease =
            on_commit(final_hash).map_err(|error| upload_residue_error(&partial_path, error))?;
        if let Err(error) = registration.begin_commit() {
            return Err(upload_residue_error(&partial_path, error));
        }
        if ssh
            .sftp_posix_rename(&partial_path, &remote_path)
            .await
            .is_err()
        {
            // The server may have committed before its response was lost. Do
            // not unlink either pathname: SFTP cannot prove path ownership.
            return Err(uncertain_upload_error(&partial_path));
        }
    } else {
        let _commit_lease =
            on_commit(final_hash).map_err(|error| upload_residue_error(&partial_path, error))?;
        if let Err(error) = registration.begin_commit() {
            return Err(upload_residue_error(&partial_path, error));
        }
    }
    Ok(transferred)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UploadMode {
    Legacy,
    Journaled,
}

/// Legacy single-file upload IPC adapter. New callers should use
/// `ssh_transfer_upload`, which adds attempts and typed terminal outcomes.
pub(crate) async fn legacy_upload_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    on_progress: Channel<UploadProgress>,
) -> Result<u64, String> {
    upload_file(
        state,
        id,
        transfer_id,
        local_path,
        None,
        remote_path,
        overwrite,
        UploadMode::Legacy,
        |progress| {
            let _ = on_progress.send(progress);
        },
        None,
        |_, _| Ok(()),
        |_, _, _| Ok(()),
        |_| Ok(None),
        None,
    )
    .await
}

/// Pick the better of an SFTP-derived path and an `echo $HOME` exec result.
///
/// `canonicalize(".")` is the cheap, no-extra-round-trip way to learn the remote
/// home, and on a normal OpenSSH server the SFTP subsystem starts in the user's
/// home so it returns e.g. `/home/you`. But some sftp-server implementations
/// (and chroot setups) start the subsystem at `/`, so `.` canonicalizes to the
/// filesystem root and the file panel gets stuck showing only root-level files.
///
/// When the SFTP answer is unusable (`/`, empty, or the SFTP call failed) we
/// fall back to the shell's `$HOME`. We only *accept* the exec answer if it is a
/// non-root absolute path — otherwise (root login whose home really is `/`, or
/// garbled output) we keep the SFTP answer. Pure so it can be unit-tested
/// without a live connection.
fn choose_remote_home(sftp_home: Option<&str>, exec_home: Option<&str>) -> Option<String> {
    let usable = |p: &str| {
        let p = p.trim();
        !p.is_empty() && p != "/" && p.starts_with('/') && !p.contains('\n')
    };
    // Prefer a usable SFTP result: it's the canonical, symlink-resolved path.
    if let Some(s) = sftp_home {
        if usable(s) {
            return Some(s.trim().to_string());
        }
    }
    // SFTP was `/`/empty/failed — try the shell's $HOME.
    if let Some(e) = exec_home {
        let e = e.trim();
        if usable(e) {
            return Some(e.to_string());
        }
    }
    // Neither is a usable non-root path. Fall back to whatever SFTP gave (likely
    // `/`), which is correct for a root login and still a usable browse root.
    sftp_home
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve the remote home directory so the panel has a sensible starting point
/// for a freshly-connected session. Tries SFTP `canonicalize(".")` first and
/// falls back to the shell's `$HOME` over an exec channel when SFTP lands at the
/// filesystem root (see `choose_remote_home`).
#[tauri::command]
pub async fn ssh_fs_home(state: tauri::State<'_, PtyState>, id: u32) -> Result<String, String> {
    (async {
        let session = state.get(id).ok_or_else(|| "no session".to_string())?;
        let ssh = match session.as_ref() {
            Session::Ssh(ssh) => ssh,
            Session::Local(_) => return Err("not a remote session".to_string()),
        };

        let sftp = ssh.sftp().await?;
        let sftp_home = await_stage(
            "resolve remote home",
            SFTP_CONTROL_TIMEOUT,
            sftp.canonicalize("."),
        )
        .await
        .ok();

        // Skip the extra exec round-trip when SFTP already gave a usable home.
        let needs_fallback = sftp_home
            .as_deref()
            .map(|h| h.trim().is_empty() || h.trim() == "/")
            .unwrap_or(true);
        let exec_home = if needs_fallback {
            // `printf` avoids the trailing-newline-plus-quirks of some shells' echo;
            // a small cap is plenty for a path. Failures collapse to None.
            ssh.exec("printf '%s' \"$HOME\"", 4096).await.ok()
        } else {
            None
        };

        choose_remote_home(sftp_home.as_deref(), exec_home.as_deref())
            .ok_or_else(|| "resolve remote home failed".to_string())
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpRead, error)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_upload, choose_remote_home, preserved_upload_mode, read_remote_editable_bytes,
        reconcile_text_write_with_sftp, remote_mtime_millis, remote_replace_lock_owner_path,
        remote_replace_lock_path, remote_sibling_temp_path, remote_write_lock, shell_quote,
        stale_replace_lock_error, uncertain_upload_error, upload_residue_error,
        usable_remote_dir_name, validate_download_target, validate_fingerprint,
        validate_remote_edit_path, write_text_transaction, RemoteWriteIo, SftpWriteAdapter,
        TransactionOutcome, UploadRegistration, WriteRequest, REMOTE_WRITE_LOCKS,
    };
    use crate::modules::pty::PtyEvent;
    use crate::modules::ssh::auth::AuthOptions;
    use crate::modules::ssh::connection::{ConnectParams, HostKeyPolicy, SshSession};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::ipc::Channel;

    #[test]
    fn remote_directory_mtime_is_normalized_to_epoch_milliseconds() {
        assert_eq!(remote_mtime_millis(1_700_000_000), 1_700_000_000_000);
        assert_eq!(remote_mtime_millis(0), 0);
    }

    #[test]
    fn upload_cancellation_registry_distinguishes_cancel_from_commit() {
        let cancelled = UploadRegistration::register("test-upload-cancel").unwrap();
        assert!(cancel_upload("test-upload-cancel".into()));
        assert_eq!(cancelled.begin_commit().unwrap_err(), "upload cancelled");
        drop(cancelled);
        assert!(!cancel_upload("test-upload-cancel".into()));

        let committed = UploadRegistration::register("test-upload-commit").unwrap();
        committed.begin_commit().unwrap();
        assert!(!cancel_upload("test-upload-commit".into()));
    }

    #[test]
    fn failed_uploads_fail_closed_without_claiming_residue_was_removed() {
        let failed = upload_residue_error("/srv/.file.random.tmp", "upload cancelled".into());
        let payload: serde_json::Value = serde_json::from_str(
            failed
                .strip_prefix("tunaraUploadError:")
                .expect("structured error prefix"),
        )
        .expect("structured error JSON");
        assert_eq!(payload["kind"], "cancelled");
        assert_eq!(payload["message"], "upload cancelled");
        assert_eq!(payload["residuePath"], "/srv/.file.random.tmp");

        let uncertain = uncertain_upload_error("/srv/.file.random.tmp");
        let payload: serde_json::Value = serde_json::from_str(
            uncertain
                .strip_prefix("tunaraUploadError:")
                .expect("structured error prefix"),
        )
        .expect("structured error JSON");
        assert_eq!(payload["kind"], "uncertain");
        assert!(payload["message"]
            .as_str()
            .unwrap()
            .contains("outcome unknown"));
        assert_eq!(payload["residuePath"], "/srv/.file.random.tmp");
    }

    #[test]
    fn overwrite_preserves_the_observed_mode_and_rejects_concurrent_chmod() {
        assert_eq!(preserved_upload_mode(0o755, 0o755), Ok(0o755));
        assert_eq!(preserved_upload_mode(0o104755, 0o104755), Ok(0o4755));
        assert!(preserved_upload_mode(0o644, 0o600)
            .unwrap_err()
            .contains("permissions changed"));
    }

    #[test]
    fn stale_remote_replace_locks_fail_closed_with_recovery_context() {
        let owner = "a".repeat(64);
        let error = stale_replace_lock_error("/srv/.tunara.lock", 601, Some(&owner));
        assert!(error.0.contains("appears stale"));
        assert!(error.0.contains(&format!("owner={owner}")));
        assert!(error.0.contains("refusing automatic removal"));
        assert!(error.0.contains("/srv/.tunara.lock"));

        let unknown = stale_replace_lock_error("/srv/.tunara.lock", 601, None);
        assert!(unknown.0.contains("owner=unknown"));
    }

    // The validator confines downloads under the *real* home dir, so test
    // fixtures must be created inside home (temp_dir() lives outside home on
    // macOS, which is itself a useful negative case).
    fn unique_home_dir(tag: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let home = dirs::home_dir().expect("home dir in test env");
        home.join(format!(".tunara-sftp-test-{tag}-{unique}"))
    }

    async fn open_real_ssh_session(label: &str) -> SshSession {
        let host = std::env::var("TUNARA_SSH_SMOKE_HOST")
            .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
        let port = std::env::var("TUNARA_SSH_SMOKE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        open_ssh_session_at(host, port, HostKeyPolicy::AcceptUnknown, label).await
    }

    async fn open_ssh_session_at(
        host: String,
        port: u16,
        policy: HostKeyPolicy,
        label: &str,
    ) -> SshSession {
        let user = std::env::var("TUNARA_SSH_SMOKE_USER").unwrap_or_else(|_| "root".into());
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            SshSession::open(
                ConnectParams {
                    host,
                    port,
                    auth: AuthOptions {
                        user,
                        method: crate::modules::ssh::auth::AuthMethod::Agent,
                        identity_file: None,
                        certificate_file: None,
                        key_passphrase: None,
                        password: None,
                    },
                    policy,
                    cols: 80,
                    rows: 24,
                    initial_cwd: None,
                    inject_shell_integration: false,
                    session_id: label.into(),
                    transport_generation: "smoke".into(),
                    hop_role: "direct".into(),
                    jump_endpoint: None,
                },
                Channel::<PtyEvent>::new(|_| Ok(())),
            ),
        )
        .await
        .expect("SSH open timeout")
        .expect("SSH open")
    }

    struct ProxyControl {
        hold_server_output: Arc<std::sync::atomic::AtomicBool>,
        cut: std::sync::mpsc::Sender<()>,
    }

    fn spawn_controlled_tcp_proxy(target_host: String, target_port: u16) -> (u16, ProxyControl) {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener, TcpStream};
        use std::sync::atomic::Ordering;

        fn relay(
            mut reader: TcpStream,
            mut writer: TcpStream,
            hold: Option<Arc<std::sync::atomic::AtomicBool>>,
        ) {
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                while hold
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Acquire))
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                if writer.write_all(&buffer[..count]).is_err() {
                    break;
                }
            }
            let _ = writer.shutdown(Shutdown::Write);
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind controlled SSH proxy");
        let port = listener.local_addr().expect("proxy address").port();
        let hold_server_output = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let relay_hold = hold_server_output.clone();
        let (cut_tx, cut_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("tunara-ssh-cut-proxy".into())
            .spawn(move || {
                let (client, _) = listener.accept().expect("accept controlled SSH client");
                let upstream = TcpStream::connect((target_host.as_str(), target_port))
                    .expect("connect controlled SSH upstream");
                client.set_nodelay(true).ok();
                upstream.set_nodelay(true).ok();
                let cut_client = client.try_clone().expect("clone cut client");
                let cut_upstream = upstream.try_clone().expect("clone cut upstream");
                std::thread::spawn(move || {
                    let _ = cut_rx.recv();
                    let _ = cut_client.shutdown(Shutdown::Both);
                    let _ = cut_upstream.shutdown(Shutdown::Both);
                });
                let client_read = client.try_clone().expect("clone proxy client");
                let upstream_read = upstream.try_clone().expect("clone proxy upstream");
                let forward = std::thread::spawn(move || relay(client_read, upstream, None));
                relay(upstream_read, client, Some(relay_hold));
                forward.join().ok();
            })
            .expect("spawn controlled SSH proxy");
        (
            port,
            ProxyControl {
                hold_server_output,
                cut: cut_tx,
            },
        )
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and an authorized SSH key"]
    async fn real_ssh_safe_write_adapter_preserves_content_mode_and_conflicts() {
        let session = open_real_ssh_session("m2-safe-write-live").await;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = format!("/tmp/tunara-m2-safe-write-{unique}");
        let target = format!("{directory}/配置 file.md");
        session
            .exec(
                &format!(
                    "install -d -m 700 {} && printf 'before\\n' > {} && chmod 640 {}",
                    shell_quote(&directory),
                    shell_quote(&target),
                    shell_quote(&target),
                ),
                16 * 1024,
            )
            .await
            .expect("create isolated remote fixture");

        let sftp = session.sftp().await.expect("open SFTP");
        let adapter = SftpWriteAdapter::new(&sftp, &session, 0);
        let initial = adapter.read_regular(&target).await.expect("read initial");
        assert_eq!(initial.bytes, b"before\n");
        assert_eq!(initial.mode, 0o640);
        let initial_fingerprint = super::content_fingerprint(&initial.bytes);
        let temporary = format!("{directory}/.配置 file.md.tunara-live.tmp");
        let lock = tokio::sync::Mutex::new(());
        let saved = write_text_transaction(
            &adapter,
            &lock,
            WriteRequest {
                target: &target,
                temporary: &temporary,
                content: b"after\n",
                expected_fingerprint: &initial_fingerprint,
            },
        )
        .await
        .expect("save transaction");
        assert!(matches!(saved, TransactionOutcome::Saved { .. }));
        let observed = adapter.read_regular(&target).await.expect("read saved");
        assert_eq!(observed.bytes, b"after\n");
        assert_eq!(observed.mode, 0o640);

        session
            .exec(
                &format!(
                    "printf 'other\\n' > {} && chmod 640 {}",
                    shell_quote(&target),
                    shell_quote(&target)
                ),
                16 * 1024,
            )
            .await
            .expect("external same-size rewrite");
        let conflict_temp = format!("{directory}/.配置 file.md.tunara-conflict.tmp");
        let conflict = write_text_transaction(
            &adapter,
            &lock,
            WriteRequest {
                target: &target,
                temporary: &conflict_temp,
                content: b"draft\n",
                expected_fingerprint: &super::content_fingerprint(b"after\n"),
            },
        )
        .await
        .expect("conflict transaction");
        assert!(matches!(conflict, TransactionOutcome::Conflict { .. }));
        let after_conflict = adapter
            .read_regular(&target)
            .await
            .expect("read conflict target");
        assert_eq!(after_conflict.bytes, b"other\n");
        assert_eq!(after_conflict.mode, 0o640);

        let residue = session
            .exec(
                &format!(
                    "find {} -maxdepth 1 \\( -name '*.tunara-*.tmp' -o -name '.tunara-write-*.lock' \\) -print; rm -rf -- {}",
                    shell_quote(&directory),
                    shell_quote(&directory),
                ),
                16 * 1024,
            )
            .await
            .expect("inspect residue and clean fixture");
        assert!(residue.trim().is_empty(), "temporary residue: {residue:?}");
        session.close().expect("close SSH session");
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and an authorized SSH key"]
    async fn real_ssh_replace_status_loss_reconciles_saved_on_a_fresh_connection() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let target_host = std::env::var("TUNARA_SSH_SMOKE_HOST")
            .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
        let target_port = std::env::var("TUNARA_SSH_SMOKE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        let (proxy_port, proxy) = spawn_controlled_tcp_proxy(target_host, target_port);
        let (proxied, control) = tokio::join!(
            open_ssh_session_at(
                "127.0.0.1".into(),
                proxy_port,
                HostKeyPolicy::AcceptForTest,
                "m2-status-loss-proxied",
            ),
            open_real_ssh_session("m2-status-loss-control"),
        );
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = format!("/tmp/tunara-m2-status-loss-{unique}");
        let target = format!("{directory}/配置 file.md");
        control
            .exec(
                &format!(
                    "install -d -m 700 {} && printf 'before\\n' > {} && chmod 640 {}",
                    shell_quote(&directory),
                    shell_quote(&target),
                    shell_quote(&target),
                ),
                16 * 1024,
            )
            .await
            .expect("create status-loss fixture");

        let proxied_sftp = proxied.sftp().await.expect("open proxied SFTP");
        let control_sftp = control.sftp().await.expect("open control SFTP");
        let request_accepted = Arc::new(AtomicBool::new(false));
        let request_signal = request_accepted.clone();
        let hold = proxy.hold_server_output.clone();
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            hold.store(true, Ordering::Release);
            request_signal.store(true, Ordering::Release);
        });
        let adapter = SftpWriteAdapter::new(&proxied_sftp, &proxied, 0)
            .with_replace_test_probe(hook, std::time::Duration::from_secs(3));
        let temporary = format!("{directory}/.配置 file.md.tunara-status-loss.tmp");
        let expected = super::content_fingerprint(b"before\n");
        let attempted = super::content_fingerprint(b"after\n");
        let replace_lock_owner = super::content_fingerprint(temporary.as_bytes());
        let lock = tokio::sync::Mutex::new(());
        let transaction = write_text_transaction(
            &adapter,
            &lock,
            WriteRequest {
                target: &target,
                temporary: &temporary,
                content: b"after\n",
                expected_fingerprint: &expected,
            },
        );
        let observe_and_cut = async {
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while !request_accepted.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
                loop {
                    if let Ok((bytes, mode)) =
                        read_remote_editable_bytes(&control_sftp, &target).await
                    {
                        if bytes == b"after\n" && mode == 0o640 {
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("remote replace became visible before cut");
            proxy.cut.send(()).expect("cut proxied TCP connection");
        };
        let (outcome, ()) = tokio::join!(transaction, observe_and_cut);
        assert!(matches!(
            outcome.expect("status-loss transaction"),
            TransactionOutcome::OutcomeUnknown {
                expected_mode: 0o640,
                cleanup_pending: true,
                ..
            }
        ));

        let residue_command = format!(
            "find {} -maxdepth 1 \\( -name '*.tmp' -o -name '.tunara-write-*.lock' \\) -print",
            shell_quote(&directory),
        );
        let before_cleanup = control
            .exec(&residue_command, 16 * 1024)
            .await
            .expect("inspect residue before reconcile");
        assert!(
            !before_cleanup.trim().is_empty(),
            "a severed connection should leave owner-scoped cleanup work"
        );
        let reconciled = reconcile_text_write_with_sftp(
            &control_sftp,
            &target,
            &attempted,
            0o640,
            &replace_lock_owner,
        )
        .await
        .expect("reconcile over fresh connection");
        assert!(matches!(
            reconciled,
            crate::modules::fs::file::WriteResult::Saved { .. }
        ));
        let residue = control
            .exec(&residue_command, 16 * 1024)
            .await
            .expect("inspect status-loss residue after reconcile");
        assert!(
            residue.trim().is_empty(),
            "reconcile left owned residue: {residue:?}"
        );
        let alien_owner = "c".repeat(64);
        let lock_path = remote_replace_lock_path(&target).expect("lock path");
        let owner_path = remote_replace_lock_owner_path(&target).expect("owner path");
        control
            .exec(
                &format!(
                    "mkdir -- {} && printf '%s' {} > {}",
                    shell_quote(&lock_path),
                    shell_quote(&alien_owner),
                    shell_quote(&owner_path),
                ),
                16 * 1024,
            )
            .await
            .expect("create another transaction's lock");
        let mismatch = reconcile_text_write_with_sftp(
            &control_sftp,
            &target,
            &attempted,
            0o640,
            &replace_lock_owner,
        )
        .await
        .expect_err("must not clean another transaction's lock");
        assert!(mismatch.contains("belongs to another transaction"));
        let alien_still_present = control
            .exec(
                &format!(
                    "test -f {} && cat {}; rm -rf -- {}",
                    shell_quote(&owner_path),
                    shell_quote(&owner_path),
                    shell_quote(&directory),
                ),
                16 * 1024,
            )
            .await
            .expect("verify alien lock and clean fixture");
        assert_eq!(alien_still_present, alien_owner);
        control.close().expect("close control SSH session");
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and an authorized SSH key"]
    async fn real_ssh_independent_clients_allow_at_most_one_stale_fingerprint_save() {
        let (session_a, session_b) = tokio::join!(
            open_real_ssh_session("m2-race-a"),
            open_real_ssh_session("m2-race-b"),
        );
        let sftp_a = session_a.sftp().await.expect("open first SFTP");
        let sftp_b = session_b.sftp().await.expect("open second SFTP");
        let adapter_a = SftpWriteAdapter::new(&sftp_a, &session_a, 0);
        let adapter_b = SftpWriteAdapter::new(&sftp_b, &session_b, 0);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = format!("/tmp/tunara-m2-race-{unique}");
        session_a
            .exec(
                &format!("install -d -m 700 {}", shell_quote(&directory)),
                4096,
            )
            .await
            .expect("create race directory");

        for round in 0..12 {
            let target = format!("{directory}/race-{round}.md");
            session_a
                .exec(
                    &format!(
                        "printf 'base\\n' > {} && chmod 640 {}",
                        shell_quote(&target),
                        shell_quote(&target)
                    ),
                    4096,
                )
                .await
                .expect("create race target");
            let fingerprint = super::content_fingerprint(b"base\n");
            let temporary_a = format!("{directory}/.race-{round}.a.tmp");
            let temporary_b = format!("{directory}/.race-{round}.b.tmp");
            let lock_a = tokio::sync::Mutex::new(());
            let lock_b = tokio::sync::Mutex::new(());
            let request_a = WriteRequest {
                target: &target,
                temporary: &temporary_a,
                content: b"from-a\n",
                expected_fingerprint: &fingerprint,
            };
            let request_b = WriteRequest {
                target: &target,
                temporary: &temporary_b,
                content: b"from-b\n",
                expected_fingerprint: &fingerprint,
            };
            let (outcome_a, outcome_b) = tokio::join!(
                write_text_transaction(&adapter_a, &lock_a, request_a),
                write_text_transaction(&adapter_b, &lock_b, request_b),
            );
            let outcomes = [
                outcome_a.expect("first transaction"),
                outcome_b.expect("second transaction"),
            ];
            let saved = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, TransactionOutcome::Saved { .. }))
                .count();
            let conflicts = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, TransactionOutcome::Conflict { .. }))
                .count();
            assert_eq!(saved, 1, "round {round} outcomes: {outcomes:?}");
            assert_eq!(conflicts, 1, "round {round} outcomes: {outcomes:?}");
        }

        let residue = session_a
            .exec(
                &format!(
                    "find {} -maxdepth 1 \\( -name '*.tmp' -o -name '.tunara-write-*.lock' \\) -print; rm -rf -- {}",
                    shell_quote(&directory),
                    shell_quote(&directory),
                ),
                16 * 1024,
            )
            .await
            .expect("inspect race residue and clean fixture");
        assert!(residue.trim().is_empty(), "temporary residue: {residue:?}");
        session_a.close().expect("close first SSH session");
        session_b.close().expect("close second SSH session");
    }

    #[test]
    fn rejects_non_absolute_paths() {
        let err = validate_download_target("relative/file.txt").unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
    }

    #[test]
    fn rejects_parent_traversal_components() {
        let home = dirs::home_dir().unwrap();
        let sneaky = home.join("dir/../../etc/passwd");
        let err = validate_download_target(sneaky.to_str().unwrap()).unwrap_err();
        assert!(err.contains(".."), "got: {err}");
    }

    #[test]
    fn rejects_paths_without_a_file_name() {
        let err = validate_download_target("/").unwrap_err();
        assert!(err.contains("file") || err.contains("parent"), "got: {err}");
    }

    #[test]
    fn rejects_a_parent_directory_outside_home() {
        // /tmp exists and is absolute but is not under the home directory.
        let err = validate_download_target("/tmp/tunara-escape.bin").unwrap_err();
        assert!(err.contains("home"), "got: {err}");
    }

    #[test]
    fn accepts_a_fresh_target_inside_home() {
        let dir = unique_home_dir("ok");
        fs::create_dir_all(&dir).expect("create fixture dir");
        let target = dir.join("download.bin");
        let resolved = validate_download_target(target.to_str().unwrap());
        let cleanup = fs::remove_dir_all(&dir);
        let resolved = resolved.expect("valid target under home");
        assert!(resolved.ends_with("download.bin"));
        cleanup.ok();
    }

    #[test]
    fn refuses_to_clobber_an_existing_destination() {
        let dir = unique_home_dir("exists");
        fs::create_dir_all(&dir).expect("create fixture dir");
        let target = dir.join("already.bin");
        fs::write(&target, b"old").expect("write existing file");
        let result = validate_download_target(target.to_str().unwrap());
        let cleanup = fs::remove_dir_all(&dir);
        let err = result.unwrap_err();
        assert!(err.contains("exists"), "got: {err}");
        cleanup.ok();
    }

    #[test]
    fn refuses_sensitive_directories_inside_home() {
        // Only run when ~/.ssh actually exists (canonicalize requires the parent
        // to exist); on CI without it, skip rather than fail.
        let ssh_dir = dirs::home_dir().unwrap().join(".ssh");
        if !ssh_dir.is_dir() {
            return;
        }
        let target = ssh_dir.join("tunara-evil-authorized_keys");
        if target.exists() {
            return; // never clobber a real key file in a test
        }
        let err = validate_download_target(target.to_str().unwrap()).unwrap_err();
        assert!(err.contains(".ssh"), "got: {err}");
    }

    // Regression: a home-ROOT shell/login rc file (parent == home, so it clears
    // the directory blocklist) must still be refused — a remote-controlled write
    // to ~/.zshrc/.zshenv/.profile is code execution on the next shell. Uses a
    // name that (almost certainly) does not yet exist so the rejection proves the
    // rc-file guard fired, not the pre-existing exists()/create_new overwrite
    // guard. This test FAILS on the old directory-only blocklist.
    #[test]
    fn refuses_home_root_shell_rc_files() {
        let home = dirs::home_dir().unwrap();
        for rc in [".zshenv", ".zprofile", ".bash_login", ".zlogin"] {
            let target = home.join(rc);
            // Skip a name that happens to exist so we never risk clobbering a
            // real dotfile and never let the exists() guard mask the rc guard.
            if target.exists() {
                continue;
            }
            let err = validate_download_target(target.to_str().unwrap())
                .expect_err("home-root shell rc file must be refused");
            assert!(
                err.contains("shell startup") || err.contains(rc),
                "rc={rc} got: {err}"
            );
        }
    }

    // A non-rc regular file at the home root is still allowed (the rc guard must
    // not over-reach and block ordinary downloads to home).
    #[test]
    fn allows_ordinary_home_root_file() {
        let home = dirs::home_dir().unwrap();
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let target = home.join(format!(".tunara-ordinary-{unique}.bin"));
        // A dotfile that is NOT a shell rc file must pass (dot-prefix alone is
        // not the disqualifier — only the known startup-file names are).
        let resolved =
            validate_download_target(target.to_str().unwrap()).expect("ordinary home file ok");
        assert!(resolved.ends_with(format!(".tunara-ordinary-{unique}.bin").as_str()));
    }

    // Regression: the sensitive-dir blocklist must survive a SYMLINKED config
    // dir. `real_parent` is symlink-resolved, so the blocklist needle must be
    // too — otherwise `~/.config -> ~/.dotfiles/config` writes past the guard.
    #[test]
    fn refuses_symlinked_sensitive_dir() {
        use std::os::unix::fs::symlink;
        let home = dirs::home_dir().unwrap();
        // A fake "sensitive" name we control, symlinked to a real target dir, so
        // the test never touches the user's real ~/.ssh/.config/.gnupg.
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let real_target = home.join(format!(".tunara-symlink-real-{unique}"));
        // `.config` is a real blocklist entry. Only run when it does NOT
        // already exist as a real dir, so we never clobber the user's config.
        let link = home.join(".config");
        if link.exists() {
            return;
        }
        fs::create_dir_all(&real_target).expect("create real target");
        if symlink(&real_target, &link).is_err() {
            let _ = fs::remove_dir_all(&real_target);
            return; // symlink not permitted in this env; skip
        }
        let dest = link.join("evil.bin");
        let result = validate_download_target(dest.to_str().unwrap());
        // Clean up the symlink and real dir before asserting.
        let _ = fs::remove_file(&link);
        let _ = fs::remove_dir_all(&real_target);
        let err = result.expect_err("symlinked .config must still be refused");
        assert!(err.contains(".config"), "got: {err}");
    }

    // ── choose_remote_home: SFTP-vs-$HOME home resolution ──────────────────
    // Regression for "SSH file panel only shows root-level files": when the
    // SFTP subsystem starts at `/`, fall back to the shell's $HOME.

    #[test]
    fn prefers_usable_sftp_home_without_exec() {
        // Normal server: SFTP already gives the real home, exec not even run.
        let got = choose_remote_home(Some("/home/alice"), None);
        assert_eq!(got.as_deref(), Some("/home/alice"));
    }

    #[test]
    fn falls_back_to_exec_home_when_sftp_is_root() {
        // The bug case: SFTP canonicalizes "." to "/", $HOME has the real path.
        let got = choose_remote_home(Some("/"), Some("/home/bob"));
        assert_eq!(got.as_deref(), Some("/home/bob"));
    }

    #[test]
    fn falls_back_to_exec_home_when_sftp_failed() {
        let got = choose_remote_home(None, Some("/home/carol"));
        assert_eq!(got.as_deref(), Some("/home/carol"));
    }

    #[test]
    fn trims_trailing_whitespace_from_exec_home() {
        // `printf '%s'` shouldn't add one, but a shell profile might echo extra.
        let got = choose_remote_home(Some("/"), Some("/home/dave\n"));
        assert_eq!(got.as_deref(), Some("/home/dave"));
    }

    #[test]
    fn keeps_root_for_root_login_when_exec_also_root() {
        // root's $HOME is sometimes literally "/": don't loop, just accept root.
        let got = choose_remote_home(Some("/"), Some("/"));
        assert_eq!(got.as_deref(), Some("/"));
    }

    #[test]
    fn keeps_sftp_root_when_exec_home_is_garbage() {
        // Relative / empty / multiline exec output is rejected; SFTP `/` stands.
        assert_eq!(
            choose_remote_home(Some("/"), Some("")).as_deref(),
            Some("/")
        );
        assert_eq!(
            choose_remote_home(Some("/"), Some("not-a-path")).as_deref(),
            Some("/")
        );
        assert_eq!(
            choose_remote_home(Some("/"), Some("/a\n/b")).as_deref(),
            Some("/")
        );
    }

    #[test]
    fn returns_none_when_nothing_usable() {
        assert_eq!(choose_remote_home(None, None), None);
        assert_eq!(choose_remote_home(Some(""), None), None);
    }

    #[test]
    fn remote_dir_listings_drop_empty_and_path_like_names() {
        assert!(!usable_remote_dir_name(""));
        assert!(!usable_remote_dir_name("."));
        assert!(!usable_remote_dir_name(".."));
        assert!(!usable_remote_dir_name("/"));
        assert!(!usable_remote_dir_name("bin/ls"));
        assert!(usable_remote_dir_name("bin"));
        assert!(usable_remote_dir_name("tmp"));
    }

    #[test]
    fn remote_edit_paths_require_absolute_non_traversing_file_paths() {
        assert!(validate_remote_edit_path("/srv/app/README.md").is_ok());
        assert!(validate_remote_edit_path("/srv/可爱动物/说明 '一'.md").is_ok());
        for invalid in [
            "relative.md",
            "/srv/app/../secret",
            "/",
            "/srv/app/bad\nname",
            "/srv/app/bad\rname",
        ] {
            assert!(
                validate_remote_edit_path(invalid).is_err(),
                "accepted invalid path {invalid:?}"
            );
        }
    }

    #[test]
    fn remote_temp_is_a_hidden_sibling_and_never_the_target() {
        let target = "/srv/app/可爱 animal.md";
        let temporary = remote_sibling_temp_path(target, 3).expect("temp path");
        let second = remote_sibling_temp_path(target, 3).expect("second temp path");
        assert!(temporary.starts_with("/srv/app/.可爱 animal.md.tunara-"));
        assert!(temporary.ends_with("-3.tmp"));
        assert_ne!(temporary, target);
        assert_ne!(temporary, second);
        assert_eq!(Path::new(&temporary).parent(), Path::new(target).parent());
        let nonce = temporary
            .strip_prefix("/srv/app/.可爱 animal.md.tunara-")
            .and_then(|value| value.strip_suffix("-3.tmp"))
            .expect("nonce");
        assert_eq!(nonce.len(), 32);
        assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn replace_lock_is_a_fixed_length_hidden_sibling_scoped_to_the_full_target() {
        let first = remote_replace_lock_path("/srv/app/可爱 animal.md").expect("first lock");
        let same = remote_replace_lock_path("/srv/app/可爱 animal.md").expect("same lock");
        let other = remote_replace_lock_path("/srv/app/other.md").expect("other lock");
        assert_eq!(first, same);
        assert_ne!(first, other);
        assert_eq!(Path::new(&first).parent(), Some(Path::new("/srv/app")));
        assert!(Path::new(&first)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".tunara-write-") && name.ends_with(".lock")));
    }

    #[test]
    fn shell_quote_keeps_spaces_unicode_and_quotes_in_one_argument() {
        assert_eq!(shell_quote("/a/可爱 animal.md"), "'/a/可爱 animal.md'");
        assert_eq!(shell_quote("/a/o'brien.md"), "'/a/o'\"'\"'brien.md'");
    }

    #[test]
    fn save_fingerprint_must_be_canonical_sha256_hex() {
        assert!(validate_fingerprint(&"a".repeat(64)).is_ok());
        for invalid in ["", "abc", &"A".repeat(64), &"g".repeat(64)] {
            assert!(validate_fingerprint(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn concurrent_saves_for_one_remote_path_are_serialized() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        let lock = remote_write_lock(9_001, "/tmp/concurrent.txt");
        assert!(Arc::ptr_eq(
            &lock,
            &remote_write_lock(9_001, "/tmp/concurrent.txt")
        ));
        assert!(!Arc::ptr_eq(
            &lock,
            &remote_write_lock(9_002, "/tmp/concurrent.txt")
        ));

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let lock = lock.clone();
            let active = active.clone();
            let peak = peak.clone();
            tasks.push(tokio::spawn(async move {
                let _guard = lock.lock().await;
                let now = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                peak.fetch_max(now, AtomicOrdering::SeqCst);
                tokio::task::yield_now().await;
                active.fetch_sub(1, AtomicOrdering::SeqCst);
            }));
        }
        for task in tasks {
            task.await.expect("save task");
        }
        assert_eq!(peak.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn released_remote_write_locks_are_pruned_on_the_next_lookup() {
        let first = remote_write_lock(9_101, "/tmp/released-a.txt");
        drop(first);
        let _second = remote_write_lock(9_101, "/tmp/released-b.txt");
        let locks = REMOTE_WRITE_LOCKS
            .get()
            .expect("lock table")
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!locks.contains_key(&(9_101, "/tmp/released-a.txt".to_string())));
    }
}
