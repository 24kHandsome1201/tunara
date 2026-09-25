use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use super::{
    remote_sibling_temp_path, sftp_for, validate_remote_edit_path, SFTP_CHUNK_TIMEOUT,
    SFTP_CONTROL_TIMEOUT,
};
use crate::modules::pty::{PtyState, Session};
use crate::modules::ssh::connection::await_stage;
type UploadCancellationTable = HashMap<String, Arc<AtomicBool>>;

static UPLOAD_CANCELLATIONS: OnceLock<std::sync::Mutex<UploadCancellationTable>> = OnceLock::new();

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

async fn verify_remote_upload_content(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    expected_bytes: u64,
    expected_hash: &str,
) -> Result<(), String> {
    let mut readback = await_stage(
        "open remote upload readback",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(path),
    )
    .await?;
    let mut remote_hash = Sha256::new();
    let mut remote_bytes = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
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
        if remote_bytes > expected_bytes {
            return Err("remote upload readback exceeded expected size".into());
        }
        remote_hash.update(&buffer[..count]);
    }
    if remote_bytes != expected_bytes || format!("{:x}", remote_hash.finalize()) != expected_hash {
        return Err("remote upload readback SHA-256 mismatch".into());
    }
    Ok(())
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
/// New files and replacements are streamed to a hidden sibling.
/// New files are atomically published with OpenSSH's hardlink extension, whose
/// create-if-absent semantics cannot replace a racing destination. Replacements
/// use posix-rename. We fail before transfer when the required safe primitive is
/// unavailable. Cancellation and I/O failures never expose partial bytes at the
/// final pathname or truncate an existing destination.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_file(
    state: tauri::State<'_, PtyState>,
    id: u32,
    transfer_id: String,
    local_path: String,
    opened_source: Option<std::fs::File>,
    remote_path: String,
    overwrite: bool,
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
    let validate_opened_source_here = opened_source.is_none();
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
    let initial_source_hash = if validate_opened_source_here {
        let mut hash = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let count = source
                .read(&mut buffer)
                .await
                .map_err(|error| format!("snapshot upload source failed: {error}"))?;
            if count == 0 {
                break;
            }
            bytes = bytes.saturating_add(count as u64);
            hash.update(&buffer[..count]);
        }
        source
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|error| format!("rewind upload source failed: {error}"))?;
        if bytes != total {
            return Err("upload source length changed during initial snapshot".into());
        }
        Some(format!("{:x}", hash.finalize()))
    } else {
        None
    };

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
    let resumed_direct_destination = resume
        .as_ref()
        .is_some_and(|(partial, _)| partial == &remote_path);
    let atomic_no_replace = !overwrite && !resumed_direct_destination;
    if atomic_no_replace {
        match await_stage(
            "check remote upload destination",
            SFTP_CONTROL_TIMEOUT,
            sftp.symlink_metadata(&remote_path),
        )
        .await
        {
            Ok(_) => return Err("remote destination already exists".into()),
            Err(error) if error.to_ascii_lowercase().contains("no such") => {}
            Err(error) => return Err(error),
        }
        if !ssh.supports_sftp_hardlink().await? {
            return Err("remote SFTP server does not support safe atomic new-file upload".into());
        }
    }

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
    } else if overwrite || atomic_no_replace {
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
    let streamed_hash = format!("{:x}", content_hash.clone().finalize());
    if transferred != total {
        return Err(upload_residue_error(
            &partial_path,
            format!(
                "upload source changed during transfer: transferred {transferred} of {total} bytes"
            ),
        ));
    }
    if let Some(initial_source_hash) = initial_source_hash {
        let metadata = source.metadata().await.map_err(|error| {
            upload_residue_error(
                &partial_path,
                format!("revalidate upload source failed: {error}"),
            )
        })?;
        source
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|error| {
                upload_residue_error(
                    &partial_path,
                    format!("rewind upload source for validation failed: {error}"),
                )
            })?;
        let mut final_source_hash = Sha256::new();
        let mut final_source_bytes = 0_u64;
        loop {
            let count = source.read(&mut buffer).await.map_err(|error| {
                upload_residue_error(
                    &partial_path,
                    format!("validate upload source failed: {error}"),
                )
            })?;
            if count == 0 {
                break;
            }
            final_source_bytes = final_source_bytes.saturating_add(count as u64);
            final_source_hash.update(&buffer[..count]);
        }
        if !metadata.is_file()
            || metadata.len() != total
            || final_source_bytes != total
            || streamed_hash != initial_source_hash
            || format!("{:x}", final_source_hash.finalize()) != initial_source_hash
        {
            return Err(upload_residue_error(
                &partial_path,
                "upload source contents changed during transfer".into(),
            ));
        }
    }
    let final_hash = format!("{:x}", content_hash.finalize());
    // Mandatory full SFTP readback proves the server-side partial bytes before
    // any upload is committed. Exclusive creation does not stop another remote
    // process from mutating the new path.
    verify_remote_upload_content(&sftp, &partial_path, transferred, &final_hash)
        .await
        .map_err(|error| upload_residue_error(&partial_path, error))?;
    if overwrite {
        let _commit_lease = on_commit(final_hash.clone())
            .map_err(|error| upload_residue_error(&partial_path, error))?;
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
        if verify_remote_upload_content(&sftp, &remote_path, transferred, &final_hash)
            .await
            .is_err()
        {
            // The rename succeeded, so a failed final-path verification is an
            // indeterminate published outcome, never a completed upload.
            return Err(uncertain_upload_error(&remote_path));
        }
    } else {
        let _commit_lease = on_commit(final_hash.clone())
            .map_err(|error| upload_residue_error(&partial_path, error))?;
        if let Err(error) = registration.begin_commit() {
            return Err(upload_residue_error(&partial_path, error));
        }
        if partial_path != remote_path {
            match await_stage(
                "publish remote upload without replacement",
                SFTP_CONTROL_TIMEOUT,
                sftp.hardlink(&partial_path, &remote_path),
            )
            .await
            {
                Ok(true) => {}
                Ok(false) => {
                    return Err(upload_residue_error(
                        &partial_path,
                        "remote SFTP hardlink support disappeared before publish".into(),
                    ));
                }
                Err(_) => {
                    // A lost response cannot prove whether the final hard link
                    // was created. Keep both paths and require reconciliation.
                    return Err(uncertain_upload_error(&partial_path));
                }
            }
            if verify_remote_upload_content(&sftp, &remote_path, transferred, &final_hash)
                .await
                .is_err()
            {
                return Err(uncertain_upload_error(&remote_path));
            }
            if await_stage(
                "remove published remote upload temporary file",
                SFTP_CONTROL_TIMEOUT,
                sftp.remove_file(&partial_path),
            )
            .await
            .is_err()
            {
                return Err(uncertain_upload_error(&partial_path));
            }
        }
    }
    Ok(transferred)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
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
}
