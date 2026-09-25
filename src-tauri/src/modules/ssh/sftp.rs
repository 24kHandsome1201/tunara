// Remote file operations over SFTP (Phase 3).
//
// These mirror the local fs_* commands' return shapes (DirEntry / ReadResult)
// so the frontend FileExplorer can switch data source by session kind without
// caring about the transport. Read-only browse + download only — no remote
// plus the optimistic conflict-aware text-write contract used by the Phase 2 editor.
//
// Each command takes the session `id` (the same u32 PtyState id the terminal
// uses) and reaches the live SSH connection's SFTP subsystem.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};
use std::time::Duration;

use russh_sftp::protocol::FileAttributes;

use crate::modules::fs::head::FileHeadResultV1;
use crate::modules::pty::PtyState;

mod browse;
mod read;
mod transfer;
mod write;

pub use browse::{ssh_fs_home, ssh_fs_read_dir};
pub use read::{
    ssh_file_view_head_v1, ssh_file_view_tail_v1, ssh_fs_read_file, ssh_fs_read_if_changed_v1,
};
pub(crate) use transfer::{
    cancel_upload, ensure_download_parents, legacy_download_file, legacy_upload_file, upload_file,
    validate_download_target, UploadProgress, MAX_DOWNLOAD_BYTES,
};
pub use write::{ssh_fs_reconcile_text_write, ssh_fs_write_text_file};

pub(crate) use browse::{__cmd__ssh_fs_home, __cmd__ssh_fs_read_dir};
pub(crate) use read::{
    __cmd__ssh_file_view_head_v1, __cmd__ssh_file_view_tail_v1, __cmd__ssh_fs_read_file,
    __cmd__ssh_fs_read_if_changed_v1,
};
pub(crate) use write::{__cmd__ssh_fs_reconcile_text_write, __cmd__ssh_fs_write_text_file};

pub(crate) use browse::{__tauri_command_name_ssh_fs_home, __tauri_command_name_ssh_fs_read_dir};
pub(crate) use read::{
    __tauri_command_name_ssh_file_view_head_v1, __tauri_command_name_ssh_file_view_tail_v1,
    __tauri_command_name_ssh_fs_read_file, __tauri_command_name_ssh_fs_read_if_changed_v1,
};
pub(crate) use write::{
    __tauri_command_name_ssh_fs_reconcile_text_write, __tauri_command_name_ssh_fs_write_text_file,
};
// 256 KiB preview cap, matching the local fs_read_file UI preview budget.
const MAX_TEXT_PREVIEW_BYTES: u64 = 256 * 1024;
// 10 MiB hard read cap, matching local fs.

const SFTP_CONTROL_TIMEOUT: Duration = Duration::from_secs(15);

const SFTP_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);

const SFTP_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileObservationV1 {
    pub kind: FileObservationKindV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileObservationKindV1 {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ReadIfChangedViewV1 {
    Preview,
    Head { line_limit: u32 },
    Tail { line_limit: u32 },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ReadIfChangedValueV1 {
    Preview(RemoteReadResult),
    Bounded(FileHeadResultV1),
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ReadIfChangedResultV1 {
    Unchanged {
        observation: FileObservationV1,
    },
    Changed {
        observation: FileObservationV1,
        value: ReadIfChangedValueV1,
    },
}

fn observation(attrs: &FileAttributes) -> FileObservationV1 {
    let kind = if attrs.is_symlink() {
        FileObservationKindV1::Symlink
    } else if attrs.is_regular() {
        FileObservationKindV1::File
    } else if attrs.is_dir() {
        FileObservationKindV1::Directory
    } else {
        FileObservationKindV1::Other
    };
    FileObservationV1 {
        kind,
        size: attrs.size,
        mode: attrs.permissions,
        modified_at: attrs.mtime.map(remote_mtime_millis),
    }
}

/// Missing attrs are deliberately never evidence of equality.
fn observation_completely_matches(known: &FileObservationV1, current: &FileObservationV1) -> bool {
    known.kind == current.kind
        && known.size.is_some()
        && known.size == current.size
        && known.mode.is_some()
        && known.mode == current.mode
        && known.modified_at.is_some()
        && known.modified_at == current.modified_at
}

fn content_fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn remote_mtime_millis(seconds: u32) -> u64 {
    u64::from(seconds).saturating_mul(1_000)
}

pub(crate) fn validate_remote_edit_path(path: &str) -> Result<(&Path, &str), String> {
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

/// Resolve the SshSession behind a session id, or a descriptive error.
pub(crate) async fn sftp_for(
    state: &tauri::State<'_, PtyState>,
    id: u32,
) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
    super::sftp_common::session(state.inner(), id).await
}

#[cfg(test)]
mod tests;
