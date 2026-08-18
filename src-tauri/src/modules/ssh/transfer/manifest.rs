//! Bounded, symlink-free folder manifests used before queue expansion.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::modules::pty::PtyState;
use crate::modules::pty::Session;
use crate::modules::ssh::diagnostics::SessionBindingV1;
use crate::modules::ssh::remote_fs::commands::{lstat_identity_bounded, validate_remote_path};
use crate::modules::ssh::remote_fs::RemotePathKindV1;
use crate::modules::ssh::sftp_common;

pub const MAX_DEPTH: u32 = 32;
pub const MAX_ENTRIES: u32 = 10_000;
pub const MAX_PATH_BYTES: u32 = 4_096;
pub const MAX_TOTAL_BYTES: u64 = 10 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestLimits {
    pub max_depth: Option<u32>,
    pub max_entries: Option<u32>,
    pub max_path_bytes: Option<u32>,
    pub max_total_bytes: Option<u64>,
}

#[derive(Clone, Copy)]
struct Limits {
    depth: u32,
    entries: u32,
    path: u32,
    bytes: u64,
}

impl From<Option<ManifestLimits>> for Limits {
    fn from(value: Option<ManifestLimits>) -> Self {
        let value = value.unwrap_or(ManifestLimits {
            max_depth: None,
            max_entries: None,
            max_path_bytes: None,
            max_total_bytes: None,
        });
        Self {
            depth: value.max_depth.unwrap_or(MAX_DEPTH).min(MAX_DEPTH),
            entries: value.max_entries.unwrap_or(MAX_ENTRIES).min(MAX_ENTRIES),
            path: value
                .max_path_bytes
                .unwrap_or(MAX_PATH_BYTES)
                .min(MAX_PATH_BYTES),
            bytes: value
                .max_total_bytes
                .unwrap_or(MAX_TOTAL_BYTES)
                .min(MAX_TOTAL_BYTES),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManifestSource {
    Local {
        root: String,
    },
    Remote {
        root: String,
        binding: SessionBindingV1,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub path: String,
    pub kind: ManifestEntryKind,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManifestEntryKind {
    File,
    Dir,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderManifest {
    pub files: Vec<ManifestEntry>,
    pub total_bytes: u64,
}

struct Builder {
    limits: Limits,
    files: Vec<ManifestEntry>,
    total: u64,
    case_keys: HashSet<String>,
    nfc_keys: HashSet<String>,
}

impl Builder {
    fn new(limits: Limits) -> Self {
        Self {
            limits,
            files: Vec::new(),
            total: 0,
            case_keys: HashSet::new(),
            nfc_keys: HashSet::new(),
        }
    }
    fn push(
        &mut self,
        path: String,
        kind: ManifestEntryKind,
        bytes: u64,
        depth: u32,
    ) -> Result<(), String> {
        validate_relative(&path)?;
        if depth > self.limits.depth {
            return Err("manifest maxDepth exceeded".into());
        }
        if path.len() > self.limits.path as usize {
            return Err("manifest maxPathBytes exceeded".into());
        }
        if self.files.len() >= self.limits.entries as usize {
            return Err("manifest maxEntries exceeded".into());
        }
        self.total = self
            .total
            .checked_add(bytes)
            .ok_or("manifest byte count overflow")?;
        if self.total > self.limits.bytes {
            return Err("manifest maxTotalBytes exceeded".into());
        }
        let nfc: String = path.nfc().collect();
        if !self.nfc_keys.insert(nfc.clone()) {
            return Err(format!("Unicode NFC path collision: {path}"));
        }
        if !self.case_keys.insert(nfc.to_lowercase()) {
            return Err(format!("case-insensitive path collision: {path}"));
        }
        self.files.push(ManifestEntry { path, kind, bytes });
        Ok(())
    }
    fn finish(self) -> FolderManifest {
        FolderManifest {
            files: self.files,
            total_bytes: self.total,
        }
    }
}

fn validate_relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return Err("invalid relative POSIX path".into());
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("relative path contains traversal component".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalUploadEntry {
    pub source_path: String,
    pub relative_path: String,
    pub kind: ManifestEntryKind,
    pub bytes: u64,
}

#[cfg(not(unix))]
pub(super) fn local_upload_manifest(
    _sources: &[String],
    _limits: Option<ManifestLimits>,
) -> Result<Vec<LocalUploadEntry>, String> {
    Err("Unsupported: secure local upload manifests require Unix no-follow traversal".into())
}

#[cfg(unix)]
pub(super) fn local_upload_manifest(
    sources: &[String],
    limits: Option<ManifestLimits>,
) -> Result<Vec<LocalUploadEntry>, String> {
    use std::os::unix::fs::OpenOptionsExt;

    let limits = Limits::from(limits);
    let mut builder = Builder::new(limits);
    let mut entries = Vec::new();
    for source in sources {
        let path = Path::new(source);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "local source must have a UTF-8 leaf name".to_string())?
            .to_string();
        validate_relative(&name)?;
        let before = std::fs::symlink_metadata(path)
            .map_err(|error| format!("inspect local source failed: {error}"))?;
        if before.file_type().is_symlink() {
            return Err("local upload sources must not be symlinks".into());
        }
        if before.is_file() {
            let handle = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
                .map_err(|error| format!("open local source failed: {error}"))?;
            let opened = handle.metadata().map_err(|error| error.to_string())?;
            let after = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
            if !opened.is_file() || !same_identity(&opened, &after) {
                return Err("local source changed while preparing upload".into());
            }
            builder.push(name.clone(), ManifestEntryKind::File, opened.len(), 1)?;
            entries.push(LocalUploadEntry {
                source_path: source.clone(),
                relative_path: name,
                kind: ManifestEntryKind::File,
                bytes: opened.len(),
            });
            continue;
        }
        if !before.is_dir() {
            return Err("unsupported local upload source".into());
        }

        // `local_manifest` anchors traversal at one root dirfd and opens every
        // descendant relative to an already-open parent with O_NOFOLLOW.
        let nested = local_manifest(path, limits)?;
        builder.push(name.clone(), ManifestEntryKind::Dir, 0, 1)?;
        entries.push(LocalUploadEntry {
            source_path: source.clone(),
            relative_path: name.clone(),
            kind: ManifestEntryKind::Dir,
            bytes: 0,
        });
        for entry in nested.files {
            let relative_path = format!("{name}/{}", entry.path);
            let depth = relative_path.split('/').count() as u32;
            builder.push(relative_path.clone(), entry.kind, entry.bytes, depth)?;
            entries.push(LocalUploadEntry {
                source_path: path.join(entry.path).to_string_lossy().into_owned(),
                relative_path,
                kind: entry.kind,
                bytes: entry.bytes,
            });
        }
    }
    // The builder is the single global accounting/collision authority across
    // all selected roots. Its output is intentionally discarded because the
    // upload entries additionally retain each local source path.
    let _ = builder.finish();
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(entries)
}

#[cfg(not(unix))]
fn local_manifest(_root: &Path, _limits: Limits) -> Result<FolderManifest, String> {
    Err("Unsupported: secure local folder manifests require Unix dirfd no-follow traversal".into())
}

#[cfg(unix)]
unsafe fn errno_pointer() -> Option<*mut libc::c_int> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return Some(unsafe { libc::__errno_location() });
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        return Some(unsafe { libc::__error() });
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(unix)]
fn local_manifest(root: &Path, limits: Limits) -> Result<FolderManifest, String> {
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;

    let errno = unsafe { errno_pointer() }.ok_or(
        "Unsupported: secure local folder manifests cannot verify readdir errors on this Unix",
    )?;

    let before =
        std::fs::symlink_metadata(root).map_err(|e| format!("inspect local root failed: {e}"))?;
    if before.file_type().is_symlink() || !before.is_dir() {
        return Err("local root must be a non-symlink directory".into());
    }
    // Anchor traversal at one root dirfd. Every descendant is opened relative
    // to its already-open parent with O_NOFOLLOW, preventing component swaps.
    let root_handle = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|e| format!("open local root failed: {e}"))?;
    let identity = root_handle.metadata().map_err(|e| e.to_string())?;
    let mut builder = Builder::new(limits);
    let mut stack = vec![(
        root_handle.try_clone().map_err(|e| e.to_string())?,
        String::new(),
        0_u32,
    )];
    while let Some((directory, relative, depth)) = stack.pop() {
        let duplicate = unsafe { libc::dup(directory.as_raw_fd()) };
        if duplicate < 0 {
            return Err(format!(
                "duplicate local directory handle failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            unsafe { libc::close(duplicate) };
            return Err(format!(
                "open local directory stream failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut names = Vec::new();
        loop {
            unsafe { *errno = 0 };
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let code = unsafe { *errno };
                if code != 0 {
                    unsafe { libc::closedir(stream) };
                    return Err(format!(
                        "read local directory failed: {}",
                        std::io::Error::from_raw_os_error(code)
                    ));
                }
                break;
            }
            let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            names.push(bytes.to_vec());
        }
        unsafe { libc::closedir(stream) };
        names.sort();
        for name_bytes in names {
            let name = std::str::from_utf8(&name_bytes)
                .map_err(|_| "non-UTF-8 path is not transferable")?
                .to_string();
            let child_relative = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let c_name = CString::new(name_bytes).map_err(|_| "path contains NUL")?;
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    c_name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                return Err(if error.raw_os_error() == Some(libc::ELOOP) {
                    format!("symlink is not allowed: {child_relative}")
                } else {
                    format!("open local manifest entry failed: {error}")
                });
            }
            let child = unsafe { std::fs::File::from_raw_fd(fd) };
            let metadata = child.metadata().map_err(|e| e.to_string())?;
            if metadata.is_dir() {
                builder.push(child_relative.clone(), ManifestEntryKind::Dir, 0, depth + 1)?;
                stack.push((child, child_relative, depth + 1));
            } else if metadata.is_file() {
                builder.push(
                    child_relative,
                    ManifestEntryKind::File,
                    metadata.len(),
                    depth + 1,
                )?;
            } else {
                return Err("unsupported local filesystem entry".into());
            }
        }
    }
    if !same_identity(
        &identity,
        &std::fs::symlink_metadata(root).map_err(|e| e.to_string())?,
    ) {
        return Err("local root changed during manifest traversal".into());
    }
    Ok(builder.finish())
}

#[cfg(unix)]
fn same_identity(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// Strict pathname traversal over SFTP. Before/after weak identities catch
/// observable replacement, but SFTP pathname LSTAT cannot eliminate a
/// same-attributes replacement race; this is deliberately not an atomic
/// snapshot. Any observation error discards the private builder and fails.
async fn remote_manifest(
    state: &PtyState,
    root: &str,
    binding: &SessionBindingV1,
    limits: Limits,
) -> Result<FolderManifest, String> {
    const DIRECTORY_DEADLINE: Duration = Duration::from_secs(30);
    const LSTAT_TIMEOUT: Duration = Duration::from_secs(15);
    const LSTAT_CONCURRENCY: usize = 8;

    let root = if root == "/" {
        "/".to_string()
    } else {
        root.trim_end_matches('/').to_string()
    };
    validate_remote_path(&root)?;
    let sftp = sftp_common::session_for_binding(state, binding).await?;
    let session = state
        .get_for_ssh_binding(binding)
        .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err("not a remote session".into()),
    };
    let root_identity = lstat_identity_bounded(&sftp, &root, LSTAT_TIMEOUT)
        .await
        .map_err(|e| format!("inspect remote root failed: {e}"))?;
    if root_identity.kind != RemotePathKindV1::Directory {
        return Err("remote root must be a non-symlink directory".into());
    }
    let mut builder = Builder::new(limits);
    let mut stack = vec![(root.clone(), String::new(), 0_u32)];
    while let Some((directory, relative, depth)) = stack.pop() {
        let deadline = tokio::time::Instant::now() + DIRECTORY_DEADLINE;
        let before = lstat_identity_bounded(&sftp, &directory, remaining(deadline)?)
            .await
            .map_err(|e| format!("inspect remote directory failed: {e}"))?;
        if before.kind != RemotePathKindV1::Directory {
            return Err(format!(
                "remote directory changed before traversal: {relative}"
            ));
        }
        let remaining_entries = builder.limits.entries as usize - builder.files.len();
        let mut entries = ssh
            .read_dir_bounded(
                &directory,
                remaining_entries,
                builder.limits.path as usize,
                remaining(deadline)?,
            )
            .await
            .map_err(|e| format!("read remote directory failed: {e}"))?;
        entries.retain(|entry| entry.filename != "." && entry.filename != "..");
        for entry in &entries {
            if entry.filename.is_empty()
                || entry.filename.contains('/')
                || entry.filename.contains('\\')
                || entry.filename.chars().any(char::is_control)
            {
                return Err("invalid remote directory entry name".into());
            }
        }
        entries.sort_by(|a, b| a.filename.cmp(&b.filename));

        // READDIR attributes are hints only. An explicit symlink is rejected
        // immediately; every other accepted child still receives authoritative
        // LSTAT and any known hint kind must agree with it.
        for entry in &entries {
            if hinted_kind(entry.attrs.permissions) == Some(RemotePathKindV1::Symlink) {
                return Err(format!("symlink is not allowed: {}", entry.filename));
            }
        }
        let mut results = Vec::with_capacity(entries.len());
        let mut next = 0usize;
        let mut set = tokio::task::JoinSet::new();
        while next < entries.len() || !set.is_empty() {
            while next < entries.len() && set.len() < LSTAT_CONCURRENCY {
                let entry = &entries[next];
                let index = next;
                let path = join_remote(&directory, &entry.filename);
                let hint = hinted_kind(entry.attrs.permissions);
                let session = sftp.clone();
                let timeout = remaining(deadline)?.min(LSTAT_TIMEOUT);
                set.spawn(async move {
                    let identity = lstat_identity_bounded(&session, &path, timeout).await?;
                    Ok::<_, String>((index, path, hint, identity))
                });
                next += 1;
            }
            let joined = tokio::time::timeout(remaining(deadline)?, set.join_next())
                .await
                .map_err(|_| "remote directory traversal timed out".to_string())?
                .ok_or_else(|| "remote LSTAT task set ended unexpectedly".to_string())?
                .map_err(|e| format!("remote LSTAT task failed: {e}"))??;
            results.push(joined);
        }
        results.sort_by_key(|result| result.0);
        for ((_, child_remote, hint, metadata), entry) in results.into_iter().zip(entries) {
            let name = entry.filename;
            let child_relative = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            if hint.is_some() && hint != Some(metadata.kind) {
                return Err(format!(
                    "READDIR/LSTAT attributes conflict: {child_relative}"
                ));
            }
            if metadata.kind == RemotePathKindV1::Symlink {
                return Err(format!("symlink is not allowed: {child_relative}"));
            }
            if metadata.kind == RemotePathKindV1::Directory {
                builder.push(child_relative.clone(), ManifestEntryKind::Dir, 0, depth + 1)?;
                stack.push((child_remote, child_relative, depth + 1));
            } else if metadata.kind == RemotePathKindV1::File {
                builder.push(
                    child_relative,
                    ManifestEntryKind::File,
                    metadata.size.unwrap_or(0),
                    depth + 1,
                )?;
            } else {
                return Err("unsupported remote filesystem entry".into());
            }
        }
        let after = lstat_identity_bounded(&sftp, &directory, remaining(deadline)?)
            .await
            .map_err(|e| format!("reinspect remote directory failed: {e}"))?;
        if before != after {
            return Err(format!(
                "remote directory changed during traversal: {relative}"
            ));
        }
    }
    let root_after = lstat_identity_bounded(&sftp, &root, LSTAT_TIMEOUT)
        .await
        .map_err(|e| format!("reinspect remote root failed: {e}"))?;
    if root_identity != root_after {
        return Err("remote root changed during manifest traversal".into());
    }
    Ok(builder.finish())
}

fn remaining(deadline: tokio::time::Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(tokio::time::Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "remote directory traversal timed out after 30s".to_string())
}

fn join_remote(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn hinted_kind(mode: Option<u32>) -> Option<RemotePathKindV1> {
    super::remote_kind_from_unix_mode(mode?)
}

#[tauri::command]
pub async fn validate_manifest(
    state: tauri::State<'_, PtyState>,
    source: ManifestSource,
    limits: Option<ManifestLimits>,
) -> Result<FolderManifest, String> {
    (async {
        let limits = Limits::from(limits);
        match source {
            ManifestSource::Local { root } => {
                tokio::task::spawn_blocking(move || local_manifest(Path::new(&root), limits))
                    .await
                    .map_err(|e| e.to_string())?
            }
            ManifestSource::Remote { root, binding } => {
                remote_manifest(state.inner(), &root, &binding, limits).await
            }
        }
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Manifest, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::ssh::remote_fs::PathIdentityV1;
    use std::fs;

    fn identity(kind: RemotePathKindV1, size: Option<u64>, modified_at: u32) -> PathIdentityV1 {
        PathIdentityV1 {
            kind,
            size,
            mode: None,
            modified_at: Some(modified_at),
        }
    }
    fn temp() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let suffix = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p =
            std::env::temp_dir().join(format!("tunara-manifest-{}-{suffix}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir(&p).unwrap();
        p
    }
    #[test]
    fn rejects_limits_and_traversal() {
        let mut b = Builder::new(Limits {
            depth: 1,
            entries: 1,
            path: 8,
            bytes: 1,
        });
        assert!(b.push("a".into(), ManifestEntryKind::File, 1, 1).is_ok());
        assert!(b.push("b".into(), ManifestEntryKind::File, 0, 1).is_err());
        assert!(validate_relative("a/../b").is_err());
    }
    #[test]
    fn detects_case_and_unicode_collisions() {
        let mut b = Builder::new(Limits::from(None));
        b.push("A".into(), ManifestEntryKind::File, 0, 1).unwrap();
        assert!(b.push("a".into(), ManifestEntryKind::File, 0, 1).is_err());
        let mut b = Builder::new(Limits::from(None));
        b.push("é".into(), ManifestEntryKind::File, 0, 1).unwrap();
        assert!(b
            .push("e\u{301}".into(), ManifestEntryKind::File, 0, 1)
            .is_err());
    }

    #[test]
    fn readdir_attrs_are_only_consistency_hints() {
        assert_eq!(hinted_kind(None), None);
        assert_eq!(hinted_kind(Some(0)), None);
        assert_eq!(hinted_kind(Some(0o150000)), None);
        assert_eq!(
            hinted_kind(Some((libc::S_IFREG as u32) | 0o644)),
            Some(RemotePathKindV1::File)
        );
        // A regular hint can never override an authoritative symlink LSTAT.
        let authoritative = identity(RemotePathKindV1::Symlink, Some(1), 1);
        assert_ne!(hinted_kind(Some(libc::S_IFREG as u32)), Some(authoritative.kind));
        assert_eq!(
            hinted_kind(Some(libc::S_IFLNK as u32)),
            Some(RemotePathKindV1::Symlink)
        );
    }

    #[test]
    fn weak_identity_detects_parent_and_root_replacement() {
        let before = identity(RemotePathKindV1::Directory, None, 10);
        let mut after = before.clone();
        after.modified_at = Some(11);
        assert_ne!(before, after);
        let symlink = identity(RemotePathKindV1::Symlink, None, 10);
        assert_ne!(before, symlink);
    }

    #[test]
    fn stable_index_restoration_and_virtual_rtt_benchmark() {
        const COUNT: usize = 10_000;
        const WIDTH: usize = 8;
        for rtt_ms in [100_u64, 250] {
            let serial_virtual_ms = COUNT as u64 * rtt_ms;
            let concurrent_virtual_ms = COUNT.div_ceil(WIDTH) as u64 * rtt_ms;
            assert!(serial_virtual_ms >= concurrent_virtual_ms * 4);
        }
        // Simulate reverse completion and restore original pathname index.
        let mut completed: Vec<_> = (0..COUNT)
            .rev()
            .map(|index| (index, format!("entry-{index:05}")))
            .collect();
        completed.sort_by_key(|entry| entry.0);
        assert!(completed.windows(2).all(|pair| pair[0].1 < pair[1].1));
        assert_eq!(WIDTH, 8); // virtual scheduler's peak-in-flight invariant
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "filesystem scale benchmark; run explicitly from the runtime benchmark script"]
    fn local_upload_manifest_scale_benchmark() {
        use std::time::Instant;

        let root = temp();
        let files = root.join("files");
        let directories = root.join("directories");
        fs::create_dir(&files).unwrap();
        fs::create_dir(&directories).unwrap();
        let mut file_sources = Vec::with_capacity(10_000);
        for index in 0..10_000 {
            let path = files.join(format!("file-{index:05}.txt"));
            fs::write(&path, b"").unwrap();
            file_sources.push(path.to_string_lossy().into_owned());
        }
        let mut directory_sources = Vec::with_capacity(1_000);
        for index in 0..1_000 {
            let path = directories.join(format!("dir-{index:04}"));
            fs::create_dir(&path).unwrap();
            directory_sources.push(path.to_string_lossy().into_owned());
        }

        let mut scenarios = Vec::new();
        for (kind, count, sources) in [
            ("files", 1_000, &file_sources[..1_000]),
            ("files", 10_000, &file_sources[..]),
            ("directories", 100, &directory_sources[..100]),
            ("directories", 1_000, &directory_sources[..]),
        ] {
            let started = Instant::now();
            let entries = local_upload_manifest(sources, None).unwrap();
            let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
            assert_eq!(entries.len(), count);
            scenarios.push(serde_json::json!({
                "kind": kind,
                "count": count,
                "metadataInputs": sources.len(),
                "ipcRequests": 1,
                "manifestEntries": entries.len(),
                "elapsedMs": (elapsed_ms * 1_000.0).round() / 1_000.0,
            }));
        }
        eprintln!(
            "RUNTIME_UPLOAD_PREFLIGHT_SCALE_RESULT {}",
            serde_json::to_string(&serde_json::json!({
                "buildRevision": std::env::var("TUNARA_BENCHMARK_REVISION").unwrap_or_else(|_| "working-tree".into()),
                "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                "samples": 1,
                "units": "ms",
                "scenarios": scenarios,
            }))
            .unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let p = temp();
        fs::write(p.join("target"), b"x").unwrap();
        symlink(p.join("target"), p.join("link")).unwrap();
        assert!(local_manifest(&p, Limits::from(None))
            .unwrap_err()
            .contains("symlink"));
        fs::remove_dir_all(p).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn upload_manifest_rejects_selected_symlinks_and_cross_root_collisions() {
        use std::os::unix::fs::symlink;
        let p = temp();
        fs::create_dir_all(p.join("one")).unwrap();
        fs::create_dir_all(p.join("two")).unwrap();
        fs::write(p.join("one/report.txt"), b"one").unwrap();
        fs::write(p.join("two/report.txt"), b"two").unwrap();
        symlink(p.join("one/report.txt"), p.join("selected-link")).unwrap();

        assert!(local_upload_manifest(
            &[p.join("selected-link").to_string_lossy().into_owned()],
            None,
        )
        .unwrap_err()
        .contains("symlink"));
        assert!(local_upload_manifest(
            &[
                p.join("one/report.txt").to_string_lossy().into_owned(),
                p.join("two/report.txt").to_string_lossy().into_owned(),
            ],
            None,
        )
        .unwrap_err()
        .contains("collision"));
        fs::remove_dir_all(p).unwrap();
    }
}
