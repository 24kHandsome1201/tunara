// Remote file operations over SFTP (Phase 3).
//
// These mirror the local fs_* commands' return shapes (DirEntry / ReadResult)
// so the frontend FileExplorer can switch data source by session kind without
// caring about the transport. Read-only browse + download only — no remote
// edit/write (keeps Tunara's "no built-in editor" boundary).
//
// Each command takes the session `id` (the same u32 PtyState id the terminal
// uses) and reaches the live SSH connection's SFTP subsystem.

use serde::Serialize;

use crate::modules::pty::{PtyState, Session};

// 256 KiB preview cap, matching the local fs_read_file UI preview budget.
const MAX_TEXT_PREVIEW_BYTES: u64 = 256 * 1024;
// 10 MiB hard read cap, matching local fs.
const MAX_READ_BYTES: u64 = 10 * 1024 * 1024;

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
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
        limit: u64,
    },
}

/// Resolve the SshSession behind a session id, or a descriptive error.
async fn sftp_for(
    state: &tauri::State<'_, PtyState>,
    id: u32,
) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    match session.as_ref() {
        Session::Ssh(ssh) => ssh.sftp().await,
        Session::Local(_) => Err("not a remote session".to_string()),
    }
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
    let sftp = sftp_for(&state, id).await?;
    let include_hidden = include_hidden.unwrap_or(false);
    let entries = sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("read remote dir failed: {e}"))?;

    let mut out: Vec<RemoteDirEntry> = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata();
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
            mtime: meta.mtime.unwrap_or(0) as u64,
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
    let sftp = sftp_for(&state, id).await?;

    let meta = sftp
        .metadata(&path)
        .await
        .map_err(|e| format!("stat remote file failed: {e}"))?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_READ_BYTES {
        return Ok(RemoteReadResult::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }

    // Whole-file read is fine within the 10 MiB cap.
    let bytes = sftp
        .read(&path)
        .await
        .map_err(|e| format!("read remote file failed: {e}"))?;

    // Re-check against the actual byte count: stat (which follows symlinks and
    // can report a stale/zero size for special or growing files) may have
    // under-reported. Don't hand back a multi-MiB preview we meant to cap.
    let real_size = bytes.len() as u64;
    if real_size > MAX_READ_BYTES {
        return Ok(RemoteReadResult::TooLarge {
            size: real_size,
            limit: MAX_READ_BYTES,
        });
    }

    // Null-byte heuristic for binary detection, like the local reader.
    let preview_len = bytes.len().min(MAX_TEXT_PREVIEW_BYTES as usize);
    let slice = &bytes[..preview_len];
    if slice.contains(&0) {
        return Ok(RemoteReadResult::Binary { size });
    }
    match std::str::from_utf8(slice) {
        Ok(content) => Ok(RemoteReadResult::Text {
            content: content.to_string(),
            size,
            truncated: bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES,
        }),
        Err(_) => Ok(RemoteReadResult::Binary { size }),
    }
}

// Cap a single download so a malicious/compromised remote can't exhaust memory
// (whole file is buffered before writing). 100 MiB is generous for a file
// browser's download affordance.
const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// Validate the caller-supplied local destination. The remote fully controls
/// the downloaded bytes, so an unvetted `local_path` would let a compromised
/// SSH server write attacker content to e.g. ~/.zshrc or ~/.ssh/authorized_keys
/// (local code execution / persistence). We require: an absolute path inside
/// the user's home, not under sensitive dotfile dirs, and no overwrite.
fn validate_download_target(local_path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(local_path);
    if !path.is_absolute() {
        return Err("download path must be absolute".into());
    }
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    if !path.starts_with(&home) {
        return Err("download path must be under the home directory".into());
    }
    // Reject sensitive locations even within home.
    for sensitive in [".ssh", ".config", ".gnupg"] {
        if path.starts_with(home.join(sensitive)) {
            return Err(format!("refusing to write into ~/{sensitive}"));
        }
    }
    // UX guard (not a security boundary): refuse an existing destination so a
    // download doesn't silently clobber. This is best-effort — there's an
    // inherent gap between this check and the later write, but since the path is
    // confined to the user's own home in a desktop app, no attacker is racing
    // local file creation here; the real protections are the home-confinement
    // and dotfile-dir rejection above.
    if path.exists() {
        return Err("destination already exists".into());
    }
    Ok(path.to_path_buf())
}

/// Download a remote file to a local path. The destination is validated to a
/// safe location (see `validate_download_target`) because the bytes are
/// remote-controlled. Whole-file buffered, capped at MAX_DOWNLOAD_BYTES.
#[tauri::command]
pub async fn ssh_fs_download(
    state: tauri::State<'_, PtyState>,
    id: u32,
    remote_path: String,
    local_path: String,
) -> Result<u64, String> {
    let target = validate_download_target(&local_path)?;
    let sftp = sftp_for(&state, id).await?;

    // Reject oversized files before buffering them into memory.
    if let Ok(meta) = sftp.metadata(&remote_path).await {
        if meta.size.unwrap_or(0) > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "remote file exceeds download limit ({} MiB)",
                MAX_DOWNLOAD_BYTES / (1024 * 1024)
            ));
        }
    }

    let bytes = sftp
        .read(&remote_path)
        .await
        .map_err(|e| format!("download read failed: {e}"))?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("remote file exceeds download limit".into());
    }
    let len = bytes.len() as u64;
    tokio::fs::write(&target, &bytes)
        .await
        .map_err(|e| format!("write local file failed: {e}"))?;
    Ok(len)
}

/// Resolve the remote home directory (canonicalize ".") so the panel has a
/// sensible starting point for a freshly-connected session.
#[tauri::command]
pub async fn ssh_fs_home(state: tauri::State<'_, PtyState>, id: u32) -> Result<String, String> {
    let sftp = sftp_for(&state, id).await?;
    sftp.canonicalize(".")
        .await
        .map_err(|e| format!("resolve remote home failed: {e}"))
}
