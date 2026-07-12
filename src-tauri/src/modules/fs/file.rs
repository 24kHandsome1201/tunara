use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

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
        /// Present only when the complete editable payload was read. The UI
        /// must return it on save so an external edit cannot be overwritten.
        #[serde(skip_serializing_if = "Option::is_none")]
        fingerprint: Option<String>,
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

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum WriteResult {
    Saved { fingerprint: String, size: u64 },
    Conflict { current_fingerprint: String },
}

fn content_fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_editable_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("editable path must be a regular file".into());
    }
    if metadata.len() > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable file exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable file exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0)
        || std::str::from_utf8(&bytes).is_err()
    {
        return Err("editable file must be UTF-8 text".into());
    }
    Ok(bytes)
}

fn sibling_temp_path(path: &Path, attempt: u32) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "editable path has no parent".to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "editable file name is invalid".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(parent.join(format!(
        ".{name}.tunara-{}-{nonce}-{attempt}.tmp",
        std::process::id()
    )))
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<ReadResult, String> {
    let p = super::expand_tilde(&path);
    let editable_regular = std::fs::symlink_metadata(&p)
        .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .unwrap_or(false);
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
    Read::by_ref(&mut file)
        .take(MAX_TEXT_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            log::debug!("fs_read_file read({}) failed: {e}", p.display());
            e.to_string()
        })?;

    let mut truncated =
        size > MAX_TEXT_PREVIEW_BYTES || bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES;
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
            fingerprint: (!truncated && editable_regular)
                .then(|| content_fingerprint(content.as_bytes())),
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
                        fingerprint: None,
                    }),
                    Err(_) => Ok(ReadResult::Binary { size }),
                }
            } else {
                Ok(ReadResult::Binary { size })
            }
        }
    }
}

/// Conflict-safe local text save. The replacement is prepared in the same
/// directory, receives the original permissions, is flushed to disk, then the
/// source fingerprint is checked again immediately before atomic rename.
#[tauri::command]
pub fn fs_write_text_file(
    path: String,
    content: String,
    expected_fingerprint: String,
) -> Result<WriteResult, String> {
    if content.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable content exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    let target = super::expand_tilde(&path);
    let original_metadata =
        std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
    if original_metadata.file_type().is_symlink() || !original_metadata.is_file() {
        return Err("editable path must be a regular file".into());
    }

    let current = read_editable_bytes(&target)?;
    let current_fingerprint = content_fingerprint(&current);
    if current_fingerprint != expected_fingerprint {
        return Ok(WriteResult::Conflict {
            current_fingerprint,
        });
    }

    let new_bytes = content.as_bytes();
    let new_fingerprint = content_fingerprint(new_bytes);
    let mut temporary = None;
    for attempt in 0..16 {
        let candidate = sibling_temp_path(&target, attempt)?;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create temporary file failed: {error}")),
        }
    }
    let (temporary_path, mut temporary_file) =
        temporary.ok_or_else(|| "could not allocate temporary file".to_string())?;

    let prepared = (|| -> Result<(), String> {
        temporary_file
            .write_all(new_bytes)
            .map_err(|error| format!("write temporary file failed: {error}"))?;
        temporary_file
            .set_permissions(original_metadata.permissions())
            .map_err(|error| format!("preserve permissions failed: {error}"))?;
        temporary_file
            .sync_all()
            .map_err(|error| format!("flush temporary file failed: {error}"))?;

        let latest = read_editable_bytes(&target)?;
        let latest_fingerprint = content_fingerprint(&latest);
        if latest_fingerprint != expected_fingerprint {
            return Err(format!("conflict:{latest_fingerprint}"));
        }
        std::fs::rename(&temporary_path, &target)
            .map_err(|error| format!("atomic replace failed: {error}"))?;
        Ok(())
    })();

    if let Err(error) = prepared {
        let _ = std::fs::remove_file(&temporary_path);
        if let Some(fingerprint) = error.strip_prefix("conflict:") {
            return Ok(WriteResult::Conflict {
                current_fingerprint: fingerprint.to_string(),
            });
        }
        return Err(error);
    }

    Ok(WriteResult::Saved {
        fingerprint: new_fingerprint,
        size: new_bytes.len() as u64,
    })
}

#[cfg(test)]
mod write_tests {
    use super::{content_fingerprint, fs_read_file, fs_write_text_file, ReadResult, WriteResult};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fixture(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("tunara-file-write-{}-{name}", std::process::id()))
    }

    fn fixture_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tunara-local-safe-write-{}-{name}",
            std::process::id()
        ))
    }

    fn temporary_residue(target: &Path) -> Vec<PathBuf> {
        let Some(parent) = target.parent() else {
            return Vec::new();
        };
        let Some(name) = target.file_name().and_then(|name| name.to_str()) else {
            return Vec::new();
        };
        let prefix = format!(".{name}.tunara-");
        fs::read_dir(parent)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let entry_name = entry.file_name();
                let entry_name = entry_name.to_str()?;
                (entry_name.starts_with(&prefix) && entry_name.ends_with(".tmp"))
                    .then(|| entry.path())
            })
            .collect()
    }

    #[test]
    fn complete_regular_reads_expose_a_sha256_edit_fingerprint() {
        let path = fixture("read.txt");
        fs::write(&path, "editable\n").unwrap();
        let result = fs_read_file(path.to_string_lossy().into_owned()).unwrap();
        match result {
            ReadResult::Text {
                content,
                fingerprint,
                truncated,
                ..
            } => {
                assert_eq!(content, "editable\n");
                assert_eq!(
                    fingerprint.as_deref(),
                    Some(content_fingerprint(b"editable\n").as_str())
                );
                assert_eq!(fingerprint.unwrap().len(), 64);
                assert!(!truncated);
            }
            _ => panic!("regular UTF-8 text should be editable"),
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn atomic_write_preserves_permissions_and_returns_new_fingerprint() {
        let path = fixture("saved.txt");
        fs::write(&path, "before\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let expected = content_fingerprint(b"before\n");
        let permissions = fs::metadata(&path).unwrap().permissions();
        let result = fs_write_text_file(
            path.to_string_lossy().into_owned(),
            "after\n".into(),
            expected,
        )
        .unwrap();
        assert_eq!(
            result,
            WriteResult::Saved {
                fingerprint: content_fingerprint(b"after\n"),
                size: 6
            }
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "after\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().readonly(),
            permissions.readonly()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_fingerprint_returns_conflict_without_overwriting() {
        let path = fixture("conflict.txt");
        fs::write(&path, "external\n").unwrap();
        let result = fs_write_text_file(
            path.to_string_lossy().into_owned(),
            "mine\n".into(),
            content_fingerprint(b"old\n"),
        )
        .unwrap();
        assert_eq!(
            result,
            WriteResult::Conflict {
                current_fingerprint: content_fingerprint(b"external\n")
            }
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external\n");
        fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn local_save_reopen_same_size_conflict_and_residue_closure() {
        use std::os::unix::fs::PermissionsExt;

        let directory = fixture_directory("closure");
        let path = directory.join("配置 file.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "before\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        let initial = fs_read_file(path.to_string_lossy().into_owned()).unwrap();
        let initial_fingerprint = match initial {
            ReadResult::Text {
                content,
                fingerprint: Some(fingerprint),
                truncated: false,
                ..
            } => {
                assert_eq!(content, "before\n");
                fingerprint
            }
            _ => panic!("fixture must reopen as complete editable text"),
        };

        let saved = fs_write_text_file(
            path.to_string_lossy().into_owned(),
            "after!\n".into(),
            initial_fingerprint,
        )
        .unwrap();
        let saved_fingerprint = match saved {
            WriteResult::Saved { fingerprint, size } => {
                assert_eq!(size, 7);
                fingerprint
            }
            result => panic!("expected saved result, got {result:?}"),
        };

        let reopened = fs_read_file(path.to_string_lossy().into_owned()).unwrap();
        match reopened {
            ReadResult::Text {
                content,
                fingerprint: Some(fingerprint),
                truncated: false,
                ..
            } => {
                assert_eq!(content, "after!\n");
                assert_eq!(fingerprint, saved_fingerprint);
            }
            _ => panic!("saved fixture must reopen with its new fingerprint"),
        }

        fs::write(&path, "other!\n").unwrap();
        let conflict = fs_write_text_file(
            path.to_string_lossy().into_owned(),
            "mine!!\n".into(),
            saved_fingerprint,
        )
        .unwrap();
        assert_eq!(
            conflict,
            WriteResult::Conflict {
                current_fingerprint: content_fingerprint(b"other!\n")
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"other!\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(temporary_residue(&path).is_empty());

        println!(
            "[benchmark:m2-local-safe-write] {}",
            serde_json::json!({
                "kind": "closure",
                "saveReopen": true,
                "sameSizeConflict": true,
                "originalAfterConflict": "other!\\n",
                "mode": "0640",
                "temporaryResidue": 0
            })
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_parent_failure_preserves_original_and_leaves_no_residue() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let effective_uid = Command::new("id")
            .arg("-u")
            .output()
            .expect("read effective uid");
        if effective_uid.stdout == b"0\n" {
            eprintln!("permission fixture requires an unprivileged verifier");
            return;
        }

        let directory = fixture_directory("permission");
        let path = directory.join("protected.md");
        fs::create_dir(&directory).unwrap();
        fs::write(&path, "original\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o500)).unwrap();

        let result = fs_write_text_file(
            path.to_string_lossy().into_owned(),
            "changed!\n".into(),
            content_fingerprint(b"original\n"),
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();

        let error = result.expect_err("an unwritable parent must reject temp creation");
        assert!(error.contains("create temporary file failed"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"original\n");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(temporary_residue(&path).is_empty());

        println!(
            "[benchmark:m2-local-safe-write] {}",
            serde_json::json!({
                "kind": "permissionFailure",
                "errorReported": true,
                "originalPreserved": true,
                "mode": "0640",
                "temporaryResidue": 0
            })
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "run explicitly for the Linux local safe-write stress gate"]
    fn atomic_replace_stress_never_exposes_partial_content() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier, Mutex};
        use std::thread;

        let rounds = std::env::var("TUNARA_LOCAL_SAFE_WRITE_ROUNDS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(500);
        let directory = fixture_directory("stress");
        let path = directory.join("atomic.md");
        fs::create_dir(&directory).unwrap();
        let payload_a = [vec![b'A'; 64 * 1024 - 2], b"A\n".to_vec()].concat();
        let payload_b = [vec![b'B'; 64 * 1024 - 2], b"B\n".to_vec()].concat();
        fs::write(&path, &payload_a).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let reads = Arc::new(AtomicUsize::new(0));
        let invalid = Arc::new(Mutex::new(None::<String>));
        let barrier = Arc::new(Barrier::new(2));
        let reader_path = path.clone();
        let reader_stop = Arc::clone(&stop);
        let reader_reads = Arc::clone(&reads);
        let reader_invalid = Arc::clone(&invalid);
        let reader_barrier = Arc::clone(&barrier);
        let expected_a = payload_a.clone();
        let expected_b = payload_b.clone();
        let reader = thread::spawn(move || {
            reader_barrier.wait();
            while !reader_stop.load(Ordering::Acquire) {
                match fs::read(&reader_path) {
                    Ok(bytes) if bytes == expected_a || bytes == expected_b => {
                        reader_reads.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(bytes) => {
                        *reader_invalid.lock().unwrap() = Some(format!(
                            "observed {} bytes outside either complete payload",
                            bytes.len()
                        ));
                        reader_stop.store(true, Ordering::Release);
                    }
                    Err(error) => {
                        *reader_invalid.lock().unwrap() = Some(format!("read failed: {error}"));
                        reader_stop.store(true, Ordering::Release);
                    }
                }
            }
        });

        barrier.wait();
        let mut fingerprint = content_fingerprint(&payload_a);
        for round in 0..rounds {
            let next = if round % 2 == 0 {
                &payload_b
            } else {
                &payload_a
            };
            let result = fs_write_text_file(
                path.to_string_lossy().into_owned(),
                String::from_utf8(next.clone()).unwrap(),
                fingerprint,
            )
            .unwrap();
            fingerprint = match result {
                WriteResult::Saved { fingerprint, .. } => fingerprint,
                result => panic!("stress save must not conflict: {result:?}"),
            };
            if round % 16 == 0 {
                thread::yield_now();
            }
        }
        stop.store(true, Ordering::Release);
        reader.join().unwrap();

        let invalid = invalid.lock().unwrap().take();
        assert!(invalid.is_none(), "{}", invalid.unwrap_or_default());
        let observed_reads = reads.load(Ordering::Relaxed);
        assert!(observed_reads > 0);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(temporary_residue(&path).is_empty());

        println!(
            "[benchmark:m2-local-safe-write] {}",
            serde_json::json!({
                "kind": "atomicStress",
                "rounds": rounds,
                "concurrentReads": observed_reads,
                "partialObservations": 0,
                "mode": "0640",
                "temporaryResidue": 0
            })
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_are_never_replaced() {
        use std::os::unix::fs::symlink;
        let target = fixture("target.txt");
        let link = fixture("link.txt");
        fs::write(&target, "safe\n").unwrap();
        symlink(&target, &link).unwrap();
        let error = fs_write_text_file(
            link.to_string_lossy().into_owned(),
            "unsafe\n".into(),
            content_fingerprint(b"safe\n"),
        )
        .unwrap_err();
        assert!(error.contains("regular file"));
        assert_eq!(fs::read_to_string(&target).unwrap(), "safe\n");
        fs::remove_file(link).unwrap();
        fs::remove_file(target).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_previews_never_expose_an_edit_fingerprint() {
        use std::os::unix::fs::symlink;
        let target = fixture("preview-target.txt");
        let link = fixture("preview-link.txt");
        fs::write(&target, "read only\n").unwrap();
        symlink(&target, &link).unwrap();
        let result = fs_read_file(link.to_string_lossy().into_owned()).unwrap();
        match result {
            ReadResult::Text { fingerprint, .. } => assert_eq!(fingerprint, None),
            _ => panic!("symlink text remains readable"),
        }
        fs::remove_file(link).unwrap();
        fs::remove_file(target).unwrap();
    }
}
