use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Milliseconds since UNIX epoch; 0 if unavailable.
    pub mtime: u64,
}

/// Lists immediate children of `path`. Dirs first, then files, each sorted
/// case-insensitively. Hidden (dot-prefix) entries are filtered unless the UI
/// asks to include them.
#[tauri::command]
pub fn fs_read_dir(path: String, include_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let include_hidden = include_hidden.unwrap_or(false);
    let root = super::expand_tilde(&path);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("fs_read_dir({}) failed: {e}", root.display());
        e.to_string()
    })?;

    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !include_hidden && name.starts_with('.') {
                return None;
            }

            // `metadata()` follows symlinks → it returns the target's stat in
            // one syscall (file_type + size + mtime all derived from it). We
            // fall back to `symlink_metadata` for broken symlinks so we don't
            // silently drop them from the listing.
            let (meta, was_symlink) = match std::fs::metadata(entry.path()) {
                Ok(m) => (Some(m), false),
                Err(_) => (entry.metadata().ok(), true),
            };
            let meta = meta?;

            let kind = if was_symlink {
                EntryKind::Symlink
            } else if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };

            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            Some(DirEntry {
                name,
                kind,
                size,
                mtime,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        let rank = |k: &EntryKind| match k {
            EntryKind::Dir => 0,
            EntryKind::Symlink => 1,
            EntryKind::File => 2,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Resolves a local directory the UI only knows as `~` / `~/…` (a fresh local
/// session before OSC 7 reports its cwd) to an absolute path. Tilde expansion
/// stays backend-side so the frontend needs no `core:path` permission; an
/// unresolvable home is an error so the explorer can leave its loading state.
#[tauri::command]
pub fn fs_resolve_dir(path: String) -> Result<String, String> {
    resolve_dir_with(&path, super::expand_tilde)
}

fn resolve_dir_with(path: &str, expand: impl Fn(&str) -> PathBuf) -> Result<String, String> {
    let resolved = expand(path.trim());
    if !resolved.is_absolute() {
        return Err(format!("cannot resolve {path} to an absolute directory"));
    }
    Ok(resolved.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::resolve_dir_with;
    use crate::modules::util::expand_tilde_with;
    use std::path::Path;

    #[test]
    fn resolve_dir_expands_tilde_against_home() {
        let expand = |p: &str| expand_tilde_with(p, Some(Path::new("/Users/alice")));
        assert_eq!(resolve_dir_with("~", expand).unwrap(), "/Users/alice");
        assert_eq!(
            resolve_dir_with("~/src", expand).unwrap(),
            "/Users/alice/src"
        );
        assert_eq!(resolve_dir_with("/opt/app", expand).unwrap(), "/opt/app");
    }

    #[test]
    fn resolve_dir_rejects_unresolvable_paths() {
        let expand = |p: &str| expand_tilde_with(p, None);
        assert!(resolve_dir_with("~", expand).is_err());
        assert!(resolve_dir_with("relative", expand).is_err());
    }
}
