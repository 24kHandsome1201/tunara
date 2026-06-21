use std::io::Read;
use std::time::UNIX_EPOCH;

use serde::Serialize;

const MAX_READ_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_PREVIEW_BYTES: u64 = 256 * 1024; // UI preview cap
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ReadResult {
    Text {
        content: String,
        size: u64,
        truncated: bool,
    },
    Binary {
        size: u64,
    },
    /// File exceeds MAX_READ_BYTES. UI decides whether to offer "open anyway".
    TooLarge {
        size: u64,
        limit: u64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub mtime: u64,
    pub kind: StatKind,
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<ReadResult, String> {
    let p = super::expand_tilde(&path);
    let meta = std::fs::metadata(&p).map_err(|e| {
        log::debug!("fs_read_file stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let size = meta.len();
    if size > MAX_READ_BYTES {
        return Ok(ReadResult::TooLarge {
            size,
            limit: MAX_READ_BYTES,
        });
    }

    let mut file = std::fs::File::open(&p).map_err(|e| {
        log::debug!("fs_read_file open({}) failed: {e}", p.display());
        e.to_string()
    })?;
    let mut bytes = Vec::with_capacity(size.min(MAX_TEXT_PREVIEW_BYTES + 1) as usize);
    file.by_ref()
        .take(MAX_TEXT_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            log::debug!("fs_read_file read({}) failed: {e}", p.display());
            e.to_string()
        })?;

    let mut truncated = size > MAX_TEXT_PREVIEW_BYTES || bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES;
    if bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        bytes.truncate(MAX_TEXT_PREVIEW_BYTES as usize);
    }

    // Null-byte sniff on the first chunk. Not perfect (misses UTF-16 BOM
    // cases) but catches the common "this is a PNG" mistake cheaply.
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return Ok(ReadResult::Binary { size });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadResult::Text {
            content,
            size,
            truncated,
        }),
        Err(e) => {
            let err = e.utf8_error();
            let valid_up_to = err.valid_up_to();
            let incomplete_at_end = err.error_len().is_none();
            if truncated && incomplete_at_end && valid_up_to > 0 {
                let mut bytes = e.into_bytes();
                bytes.truncate(valid_up_to);
                truncated = true;
                match String::from_utf8(bytes) {
                    Ok(content) => Ok(ReadResult::Text {
                        content,
                        size,
                        truncated,
                    }),
                    Err(_) => Ok(ReadResult::Binary { size }),
                }
            } else {
                Ok(ReadResult::Binary { size })
            }
        }
    }
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<FileStat, String> {
    let p = super::expand_tilde(&path);
    let meta = std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
    let kind = if meta.file_type().is_symlink() {
        StatKind::Symlink
    } else if meta.is_dir() {
        StatKind::Dir
    } else {
        StatKind::File
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        size: meta.len(),
        mtime,
        kind,
    })
}
