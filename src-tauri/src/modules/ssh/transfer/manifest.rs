//! Bounded, symlink-free folder manifests used before queue expansion.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::modules::pty::PtyState;
use crate::modules::pty::Session;
use crate::modules::ssh::diagnostics::SessionBindingV1;
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

async fn remote_manifest(
    state: &PtyState,
    root: &str,
    binding: &SessionBindingV1,
    limits: Limits,
) -> Result<FolderManifest, String> {
    let sftp = sftp_common::session_for_binding(state, binding).await?;
    let session = state
        .get_for_ssh_binding(binding)
        .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err("not a remote session".into()),
    };
    let root_meta = sftp
        .symlink_metadata(root)
        .await
        .map_err(|e| format!("inspect remote root failed: {e}"))?;
    if root_meta.is_symlink() || !root_meta.is_dir() {
        return Err("remote root must be a non-symlink directory".into());
    }
    let mut builder = Builder::new(limits);
    let mut stack = vec![(root.trim_end_matches('/').to_string(), String::new(), 0_u32)];
    while let Some((directory, relative, depth)) = stack.pop() {
        let remaining = builder.limits.entries as usize - builder.files.len();
        let entries = ssh
            .read_dir_bounded(
                &directory,
                remaining,
                builder.limits.path as usize,
                Duration::from_secs(30),
            )
            .await
            .map_err(|e| format!("read remote directory failed: {e}"))?;
        for entry in entries {
            let name = entry.filename;
            if name == "." || name == ".." {
                continue;
            }
            let child_relative = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let child_remote = format!(
                "{directory}/{}",
                child_relative.rsplit('/').next().unwrap_or("")
            );
            let metadata = sftp
                .symlink_metadata(&child_remote)
                .await
                .map_err(|e| format!("inspect remote entry failed: {e}"))?;
            if metadata.is_symlink() {
                return Err(format!("symlink is not allowed: {child_relative}"));
            }
            if metadata.is_dir() {
                builder.push(child_relative.clone(), ManifestEntryKind::Dir, 0, depth + 1)?;
                stack.push((child_remote, child_relative, depth + 1));
            } else if metadata.is_regular() {
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
    }
    Ok(builder.finish())
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
    use std::fs;
    fn temp() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("tunara-manifest-{}", std::process::id()));
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
}
