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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::connection::await_stage;
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
static REMOTE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);
type RemoteWriteLock = Arc<tokio::sync::Mutex<()>>;
static REMOTE_WRITE_LOCKS: OnceLock<
    std::sync::Mutex<HashMap<(u32, String), Weak<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

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
    TooLarge {
        size: u64,
        limit: u64,
    },
}

fn content_fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
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

fn validate_remote_edit_path(path: &str) -> Result<(&Path, &str), String> {
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
    let nonce = REMOTE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(parent
        .join(format!(".{name}.tunara-{nonce}-{attempt}.tmp"))
        .to_string_lossy()
        .into_owned())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[derive(Debug, PartialEq, Eq)]
enum ReplaceReconciliation {
    Saved,
    Unchanged,
    Conflict(String),
}

fn reconcile_replace_observation(
    observed: &[u8],
    observed_mode: u32,
    attempted: &[u8],
    expected_fingerprint: &str,
    expected_mode: u32,
) -> ReplaceReconciliation {
    if observed == attempted && observed_mode == expected_mode {
        return ReplaceReconciliation::Saved;
    }
    let fingerprint = content_fingerprint(observed);
    if fingerprint == expected_fingerprint {
        ReplaceReconciliation::Unchanged
    } else {
        ReplaceReconciliation::Conflict(fingerprint)
    }
}

fn outcome_unknown_error(
    attempted_fingerprint: &str,
    expected_mode: u32,
    replace: &str,
    reconcile: &str,
) -> String {
    format!(
        "outcomeUnknown:{attempted_fingerprint}:{expected_mode:o}: atomic remote replace status was lost ({replace}); reconciliation failed ({reconcile})"
    )
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
        if name == "." || name == ".." {
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

    // Stream into a BOUNDED buffer rather than `sftp.read()` (which buffers the
    // whole file before any cap applies). The stat size above is server-
    // controlled and may under-report (special/growing files) or be a lie, so a
    // compromised peer could otherwise OOM us by streaming gigabytes. `take`
    // caps in-memory bytes at MAX_READ_BYTES + 1 regardless of what stat said;
    // reading exactly one byte past the cap lets us still report TooLarge.
    let mut file = await_stage("open remote file", SFTP_CONTROL_TIMEOUT, sftp.open(&path)).await?;
    let mut bytes: Vec<u8> = Vec::with_capacity(size.min(MAX_READ_BYTES + 1) as usize);
    await_stage(
        "read remote file",
        SFTP_PREVIEW_TIMEOUT,
        (&mut file).take(MAX_READ_BYTES + 1).read_to_end(&mut bytes),
    )
    .await?;

    // If we hit the +1 byte, the real file is larger than the cap (stat
    // under-reported or lied). Don't hand back a preview we meant to refuse.
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
            fingerprint: (editable_regular
                && bytes.len() as u64 <= MAX_TEXT_PREVIEW_BYTES
                && bytes.len() as u64 == size)
                .then(|| content_fingerprint(&bytes)),
            content: content.to_string(),
            size,
            truncated: bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES,
        }),
        Err(_) => Ok(RemoteReadResult::Binary { size }),
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
    let _write_guard = write_lock.lock().await;
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err("not a remote session".into()),
    };
    let sftp = ssh.sftp().await?;
    let (current, mode) = read_remote_editable_bytes(&sftp, &path).await?;
    let current_fingerprint = content_fingerprint(&current);
    let attempted_fingerprint = content_fingerprint(content.as_bytes());
    if current_fingerprint != expected_fingerprint {
        return Ok(crate::modules::fs::file::WriteResult::Conflict {
            current_fingerprint,
        });
    }

    let mut temporary = None;
    for attempt in 0..16 {
        let candidate = remote_sibling_temp_path(&path, attempt)?;
        let attrs = FileAttributes {
            permissions: Some(mode),
            ..FileAttributes::empty()
        };
        match await_stage(
            "create remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            sftp.open_with_flags_and_attributes(
                &candidate,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                attrs,
            ),
        )
        .await
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.contains("exist") => continue,
            Err(error) => return Err(error),
        }
    }
    let (temporary_path, mut temporary_file) =
        temporary.ok_or_else(|| "could not allocate remote temporary file".to_string())?;

    let prepared = async {
        await_stage(
            "write remote temporary file",
            SFTP_WRITE_TIMEOUT,
            temporary_file.write_all(content.as_bytes()),
        )
        .await?;
        await_stage(
            "flush remote temporary file",
            SFTP_WRITE_TIMEOUT,
            temporary_file.flush(),
        )
        .await?;
        await_stage(
            "set remote temporary permissions",
            SFTP_CONTROL_TIMEOUT,
            temporary_file.set_metadata(FileAttributes {
                permissions: Some(mode),
                ..FileAttributes::empty()
            }),
        )
        .await?;
        await_stage(
            "sync remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            temporary_file.sync_all(),
        )
        .await?;
        await_stage(
            "close remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            temporary_file.shutdown(),
        )
        .await?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = prepared {
        let _ = sftp.remove_file(&temporary_path).await;
        return Err(error);
    }

    let (latest, _) = match read_remote_editable_bytes(&sftp, &path).await {
        Ok(value) => value,
        Err(error) => {
            let _ = sftp.remove_file(&temporary_path).await;
            return Err(error);
        }
    };
    let latest_fingerprint = content_fingerprint(&latest);
    if latest_fingerprint != expected_fingerprint {
        let _ = sftp.remove_file(&temporary_path).await;
        return Ok(crate::modules::fs::file::WriteResult::Conflict {
            current_fingerprint: latest_fingerprint,
        });
    }

    let command = format!(
        "mv -f -- {} {}",
        shell_quote(&temporary_path),
        shell_quote(&path)
    );
    if let Err(error) = ssh.exec(&command, 16 * 1024).await {
        // Once the replace request was sent, a transport error cannot tell us
        // whether rename happened. Re-read before reporting. If the connection
        // is gone too, surface an explicit outcomeUnknown token; a retry with
        // the same expected fingerprint/content performs the reconciliation
        // above. Cleanup remains best effort because the temp may already have
        // become the target.
        match read_remote_editable_bytes(&sftp, &path).await {
            Ok((observed, observed_mode)) => match reconcile_replace_observation(
                &observed,
                observed_mode,
                content.as_bytes(),
                &expected_fingerprint,
                mode,
            ) {
                ReplaceReconciliation::Saved => {
                    return Ok(crate::modules::fs::file::WriteResult::Saved {
                        fingerprint: attempted_fingerprint,
                        size: observed.len() as u64,
                    });
                }
                ReplaceReconciliation::Conflict(current_fingerprint) => {
                    let _ = sftp.remove_file(&temporary_path).await;
                    return Ok(crate::modules::fs::file::WriteResult::Conflict {
                        current_fingerprint,
                    });
                }
                ReplaceReconciliation::Unchanged => {
                    let _ = sftp.remove_file(&temporary_path).await;
                    return Err(format!("atomic remote replace failed: {error}"));
                }
            },
            Err(reconcile_error) => {
                let _ = sftp.remove_file(&temporary_path).await;
                return Err(outcome_unknown_error(
                    &attempted_fingerprint,
                    mode,
                    &error,
                    &reconcile_error,
                ));
            }
        }
    }

    let (saved, saved_mode) = read_remote_editable_bytes(&sftp, &path).await?;
    if saved != content.as_bytes() || saved_mode != mode {
        return Err("remote save verification failed".into());
    }
    Ok(crate::modules::fs::file::WriteResult::Saved {
        fingerprint: content_fingerprint(&saved),
        size: saved.len() as u64,
    })
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
) -> Result<crate::modules::fs::file::WriteResult, String> {
    validate_fingerprint(&attempted_fingerprint)?;
    validate_remote_edit_path(&path)?;
    let sftp = sftp_for(&state, id).await?;
    let (observed, observed_mode) = read_remote_editable_bytes(&sftp, &path).await?;
    let current_fingerprint = content_fingerprint(&observed);
    if current_fingerprint == attempted_fingerprint && observed_mode == expected_mode {
        Ok(crate::modules::fs::file::WriteResult::Saved {
            fingerprint: current_fingerprint,
            size: observed.len() as u64,
        })
    } else {
        Ok(crate::modules::fs::file::WriteResult::Conflict {
            current_fingerprint,
        })
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
/// the user's home, not under sensitive dotfile dirs, not a home-root shell/login
/// rc file (`~/.zshrc` etc.), and no overwrite.
///
/// The confinement is enforced on the *canonicalized* parent directory, not on
/// the literal string. `Path::starts_with` is a component-wise prefix test, so
/// `~/../../etc/x` literally still "starts with" home yet resolves outside it;
/// and a symlinked subdir (e.g. `~/Downloads -> /Volumes/ext`) would let bytes
/// escape home. Canonicalizing the parent collapses `..` and resolves symlinks,
/// so the prefix test runs against the real on-disk location.
fn validate_download_target(local_path: &str) -> Result<std::path::PathBuf, String> {
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
    // clobber. The write itself uses create_new (see ssh_fs_download) so the
    // no-overwrite guarantee is atomic; this is just an earlier friendly error.
    if target.exists() {
        return Err("destination already exists".into());
    }
    Ok(target)
}

/// Download a remote file to a local path. The destination is validated to a
/// safe location (see `validate_download_target`) because the bytes are
/// remote-controlled. Streamed chunk-by-chunk (O(chunk) memory) and aborted
/// once a byte counter exceeds MAX_DOWNLOAD_BYTES.
#[tauri::command]
pub async fn ssh_fs_download(
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
}

#[cfg(test)]
mod tests {
    use super::{
        choose_remote_home, content_fingerprint, outcome_unknown_error,
        reconcile_replace_observation, remote_sibling_temp_path, remote_write_lock, shell_quote,
        validate_download_target, validate_fingerprint, validate_remote_edit_path,
        ReplaceReconciliation, REMOTE_WRITE_LOCKS,
    };
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        assert!(temporary.starts_with("/srv/app/.可爱 animal.md.tunara-"));
        assert!(temporary.ends_with("-3.tmp"));
        assert_ne!(temporary, target);
        assert_eq!(Path::new(&temporary).parent(), Path::new(target).parent());
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

    #[test]
    fn replace_error_reconciliation_distinguishes_saved_unchanged_and_conflict() {
        let before = b"AAAA\n";
        let attempted = b"CCCC\n";
        let expected = content_fingerprint(before);

        assert_eq!(
            reconcile_replace_observation(attempted, 0o640, attempted, &expected, 0o640),
            ReplaceReconciliation::Saved
        );
        assert_eq!(
            reconcile_replace_observation(before, 0o640, attempted, &expected, 0o640),
            ReplaceReconciliation::Unchanged
        );

        // Same byte length (and potentially the same mtime) must still be a
        // conflict. Only the content fingerprint is authoritative.
        let external = b"BBBB\n";
        assert_eq!(before.len(), external.len());
        assert_eq!(
            reconcile_replace_observation(external, 0o640, attempted, &expected, 0o640),
            ReplaceReconciliation::Conflict(content_fingerprint(external))
        );

        // Matching bytes with the wrong mode are not a verified successful
        // save: permission preservation is part of the transaction contract.
        assert_eq!(
            reconcile_replace_observation(attempted, 0o600, attempted, &expected, 0o640),
            ReplaceReconciliation::Conflict(content_fingerprint(attempted))
        );
    }

    #[test]
    fn lost_replace_status_has_a_machine_recognizable_outcome_unknown_error() {
        let attempted = content_fingerprint(b"after\n");
        let error = outcome_unknown_error(&attempted, 0o640, "channel closed", "no session");
        assert!(error.starts_with(&format!("outcomeUnknown:{attempted}:640:")));
        assert!(error.contains("channel closed"));
        assert!(error.contains("reconciliation failed"));
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
