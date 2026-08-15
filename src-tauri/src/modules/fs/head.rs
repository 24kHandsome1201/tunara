//! Bounded, read-only text head viewing shared by local and SFTP commands.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_HEAD_LINES: u32 = 2_000;
pub const MAX_HEAD_BYTES: usize = 256 * 1024;
pub const HEAD_CHUNK_BYTES: usize = 16 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

type CancellationTable = HashMap<String, Arc<AtomicBool>>;
static CANCELLATIONS: OnceLock<Mutex<CancellationTable>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileViewErrorV1 {
    pub code: &'static str,
    pub message: &'static str,
}

impl FileViewErrorV1 {
    pub fn invalid_request() -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: "The bounded file view request is invalid.",
        }
    }

    pub fn cancelled() -> Self {
        Self {
            code: "CANCELLED",
            message: "The bounded file view was cancelled.",
        }
    }

    pub fn changed() -> Self {
        Self {
            code: "FILE_CHANGED",
            message: "The file changed while it was being read.",
        }
    }

    pub fn permission_denied() -> Self {
        Self {
            code: "PERMISSION_DENIED",
            message: "Permission was denied while reading the file.",
        }
    }

    pub fn stale_binding() -> Self {
        Self {
            code: "STALE_BINDING",
            message: "The SSH session binding is no longer current.",
        }
    }

    pub fn read_failed() -> Self {
        Self {
            code: "READ_FAILED",
            message: "The file could not be read.",
        }
    }
}

pub fn local_io_error(error: std::io::Error) -> FileViewErrorV1 {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        FileViewErrorV1::permission_denied()
    } else {
        FileViewErrorV1::read_failed()
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileHeadResultV1 {
    Text {
        content: String,
        size: u64,
        revision: String,
        #[serde(rename = "lineCount")]
        line_count: u32,
        #[serde(rename = "lineLimit")]
        line_limit: u32,
        #[serde(rename = "byteLimit")]
        byte_limit: usize,
        truncated: bool,
    },
    Binary {
        size: u64,
        revision: String,
    },
}

pub struct RequestRegistration {
    request_id: String,
    pub cancelled: Arc<AtomicBool>,
}

impl RequestRegistration {
    pub fn register(request_id: String) -> Result<Self, FileViewErrorV1> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(FileViewErrorV1::invalid_request());
        }
        let table = CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut table = table
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if table.contains_key(&request_id) {
            return Err(FileViewErrorV1::invalid_request());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        table.insert(request_id.clone(), Arc::clone(&cancelled));
        Ok(Self {
            request_id,
            cancelled,
        })
    }
}

impl Drop for RequestRegistration {
    fn drop(&mut self) {
        let Some(table) = CANCELLATIONS.get() else {
            return;
        };
        let mut table = table
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if table
            .get(&self.request_id)
            .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancelled))
        {
            table.remove(&self.request_id);
        }
    }
}

#[tauri::command]
pub fn fs_cancel_file_view_v1(request_id: String) -> bool {
    let Some(table) = CANCELLATIONS.get() else {
        return false;
    };
    let table = table
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(cancelled) = table.get(&request_id) else {
        return false;
    };
    cancelled.store(true, Ordering::Release);
    true
}

pub fn validate_line_limit(line_limit: u32) -> Result<(), FileViewErrorV1> {
    if (1..=MAX_HEAD_LINES).contains(&line_limit) {
        Ok(())
    } else {
        Err(FileViewErrorV1::invalid_request())
    }
}

pub fn revision(size: u64, modified: Option<SystemTime>) -> String {
    let timestamp = modified
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    format!(
        "{:x}",
        Sha256::digest(format!("{size}:{timestamp}").as_bytes())
    )
}

pub fn remote_revision(size: u64, mtime: Option<u32>) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{size}:{}", mtime.unwrap_or_default()).as_bytes())
    )
}

#[derive(Default)]
pub struct HeadAccumulator {
    bytes: Vec<u8>,
    line_count: u32,
    complete: bool,
}

impl HeadAccumulator {
    pub fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(MAX_HEAD_BYTES.min(HEAD_CHUNK_BYTES)),
            ..Self::default()
        }
    }

    pub fn push(&mut self, chunk: &[u8], line_limit: u32) {
        if self.complete {
            return;
        }
        let remaining = MAX_HEAD_BYTES.saturating_sub(self.bytes.len());
        for byte in chunk.iter().copied().take(remaining) {
            self.bytes.push(byte);
            if byte == b'\n' {
                self.line_count += 1;
                if self.line_count == line_limit {
                    self.complete = true;
                    return;
                }
            }
        }
        if self.bytes.len() == MAX_HEAD_BYTES {
            self.complete = true;
        }
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn finish(
        mut self,
        size: u64,
        revision: String,
        line_limit: u32,
        reached_eof: bool,
    ) -> FileHeadResultV1 {
        let sniff_len = self.bytes.len().min(BINARY_SNIFF_BYTES);
        if self.bytes[..sniff_len].contains(&0) {
            return FileHeadResultV1::Binary { size, revision };
        }
        let content = match String::from_utf8(self.bytes) {
            Ok(content) => content,
            Err(error) if error.utf8_error().error_len().is_none() => {
                let valid = error.utf8_error().valid_up_to();
                let mut bytes = error.into_bytes();
                bytes.truncate(valid);
                String::from_utf8(bytes).expect("valid UTF-8 prefix")
            }
            Err(_) => return FileHeadResultV1::Binary { size, revision },
        };
        if !content.is_empty() && !content.ends_with('\n') {
            self.line_count += 1;
        }
        FileHeadResultV1::Text {
            content,
            size,
            revision,
            line_count: self.line_count,
            line_limit,
            byte_limit: MAX_HEAD_BYTES,
            truncated: !reached_eof,
        }
    }
}

fn skip_incomplete_utf8_prefix(bytes: &[u8]) -> &[u8] {
    let mut index = 0;
    while index < bytes.len() && bytes[index] & 0b1100_0000 == 0b1000_0000 {
        index += 1;
    }
    &bytes[index..]
}

/// Keep the last `line_limit` lines from a bounded tail window.
pub fn finish_tail(
    mut bytes: Vec<u8>,
    size: u64,
    revision: String,
    line_limit: u32,
    started_after_start: bool,
) -> FileHeadResultV1 {
    if started_after_start {
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=newline);
        }
    }
    let skipped = skip_incomplete_utf8_prefix(&bytes).to_vec();
    bytes = skipped;
    let sniff_len = bytes.len().min(BINARY_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0) {
        return FileHeadResultV1::Binary { size, revision };
    }
    let mut starts = vec![0usize];
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' && index + 1 < bytes.len() {
            starts.push(index + 1);
        }
    }
    let line_limit = line_limit as usize;
    let clipped = starts.len() > line_limit;
    if clipped {
        bytes = bytes[starts[starts.len() - line_limit]..].to_vec();
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) if error.utf8_error().error_len().is_none() => {
            let valid = error.utf8_error().valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).expect("valid UTF-8 prefix")
        }
        Err(_) => return FileHeadResultV1::Binary { size, revision },
    };
    let mut line_count = content.bytes().filter(|byte| *byte == b'\n').count() as u32;
    if !content.is_empty() && !content.ends_with('\n') {
        line_count += 1;
    }
    FileHeadResultV1::Text {
        content,
        size,
        revision,
        line_count,
        line_limit: line_limit as u32,
        byte_limit: MAX_HEAD_BYTES,
        truncated: started_after_start || clipped,
    }
}

pub fn read_local_tail_window(
    file: &mut std::fs::File,
    size: u64,
    cancelled: &AtomicBool,
) -> Result<(Vec<u8>, bool), FileViewErrorV1> {
    let offset = size.saturating_sub(MAX_HEAD_BYTES as u64);
    file.seek(SeekFrom::Start(offset))
        .map_err(local_io_error)?;
    let mut bytes = Vec::with_capacity((size - offset).min(MAX_HEAD_BYTES as u64) as usize);
    let mut chunk = [0_u8; HEAD_CHUNK_BYTES];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(FileViewErrorV1::cancelled());
        }
        let count = file.read(&mut chunk).map_err(local_io_error)?;
        if count == 0 {
            break;
        }
        let remaining = MAX_HEAD_BYTES.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..count.min(remaining)]);
        if bytes.len() == MAX_HEAD_BYTES {
            break;
        }
    }
    Ok((bytes, offset > 0))
}

#[tauri::command]
pub async fn fs_file_view_head_v1(
    path: String,
    line_limit: u32,
    request_id: String,
) -> Result<FileHeadResultV1, FileViewErrorV1> {
    validate_line_limit(line_limit)?;
    let registration = RequestRegistration::register(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _registration = registration;
        let path = super::expand_tilde(&path);
        let before = std::fs::metadata(&path).map_err(local_io_error)?;
        if !before.is_file() {
            return Err(FileViewErrorV1::read_failed());
        }
        let before_revision = revision(before.len(), before.modified().ok());
        let mut file = std::fs::File::open(&path).map_err(local_io_error)?;
        let mut accumulator = HeadAccumulator::new();
        let mut chunk = [0_u8; HEAD_CHUNK_BYTES];
        let reached_eof = loop {
            if _registration.cancelled.load(Ordering::Acquire) {
                return Err(FileViewErrorV1::cancelled());
            }
            let count = file.read(&mut chunk).map_err(local_io_error)?;
            if count == 0 {
                break true;
            }
            accumulator.push(&chunk[..count], line_limit);
            if accumulator.is_complete() {
                break false;
            }
        };
        let after = std::fs::metadata(&path).map_err(|_| FileViewErrorV1::changed())?;
        let after_revision = revision(after.len(), after.modified().ok());
        if before_revision != after_revision {
            return Err(FileViewErrorV1::changed());
        }
        Ok(accumulator.finish(before.len(), before_revision, line_limit, reached_eof))
    })
    .await
    .map_err(|_| FileViewErrorV1::read_failed())?
}

#[tauri::command]
pub async fn fs_file_view_tail_v1(
    path: String,
    line_limit: u32,
    request_id: String,
) -> Result<FileHeadResultV1, FileViewErrorV1> {
    validate_line_limit(line_limit)?;
    let registration = RequestRegistration::register(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _registration = registration;
        let path = super::expand_tilde(&path);
        let before = std::fs::metadata(&path).map_err(local_io_error)?;
        if !before.is_file() {
            return Err(FileViewErrorV1::read_failed());
        }
        let before_revision = revision(before.len(), before.modified().ok());
        let mut file = std::fs::File::open(&path).map_err(local_io_error)?;
        let (bytes, started_after_start) =
            read_local_tail_window(&mut file, before.len(), &_registration.cancelled)?;
        let after = std::fs::metadata(&path).map_err(|_| FileViewErrorV1::changed())?;
        let after_revision = revision(after.len(), after.modified().ok());
        if before_revision != after_revision {
            return Err(FileViewErrorV1::changed());
        }
        Ok(finish_tail(
            bytes,
            before.len(),
            before_revision,
            line_limit,
            started_after_start,
        ))
    })
    .await
    .map_err(|_| FileViewErrorV1::read_failed())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finish(chunks: &[&[u8]], lines: u32, eof: bool) -> FileHeadResultV1 {
        let mut accumulator = HeadAccumulator::new();
        for chunk in chunks {
            accumulator.push(chunk, lines);
        }
        accumulator.finish(999, "revision".into(), lines, eof)
    }

    #[test]
    fn stops_exactly_after_requested_lines_across_chunks() {
        let result = finish(&[b"one\ntw", b"o\nthree\n"], 2, false);
        assert!(
            matches!(result, FileHeadResultV1::Text { content, line_count: 2, truncated: true, .. } if content == "one\ntwo\n")
        );
    }

    #[test]
    fn preserves_utf8_split_across_chunks() {
        let bytes = "a😀b\n".as_bytes();
        let result = finish(&[&bytes[..3], &bytes[3..]], 10, true);
        assert!(
            matches!(result, FileHeadResultV1::Text { content, line_count: 1, truncated: false, .. } if content == "a😀b\n")
        );
    }

    #[test]
    fn bounds_a_single_very_long_line() {
        let bytes = vec![b'x'; MAX_HEAD_BYTES + HEAD_CHUNK_BYTES];
        let result = finish(&[&bytes], 1_000, false);
        assert!(
            matches!(result, FileHeadResultV1::Text { content, line_count: 1, truncated: true, .. } if content.len() == MAX_HEAD_BYTES)
        );
    }

    #[test]
    fn rejects_binary_and_invalid_limits() {
        assert!(matches!(
            finish(&[b"hello\0world"], 10, true),
            FileHeadResultV1::Binary { .. }
        ));
        assert!(validate_line_limit(0).is_err());
        assert!(validate_line_limit(MAX_HEAD_LINES + 1).is_err());
    }

    #[test]
    fn tail_keeps_the_last_requested_lines() {
        let result = finish_tail(b"one\ntwo\nthree\nfour\n".to_vec(), 20, "rev".into(), 2, false);
        assert!(matches!(
            result,
            FileHeadResultV1::Text { content, line_count: 2, truncated: true, .. }
                if content == "three\nfour\n"
        ));
    }

    #[test]
    fn tail_drops_a_partial_first_line_when_the_window_starts_mid_file() {
        let result = finish_tail(b"artial\nlast\n".to_vec(), 40, "rev".into(), 10, true);
        assert!(matches!(
            result,
            FileHeadResultV1::Text { content, truncated: true, .. } if content == "last\n"
        ));
    }
}
