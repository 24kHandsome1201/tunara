use std::future::{ready, Future};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::modules::pty::PtyState;
use crate::modules::ssh::{diagnostics::SessionBindingV1, sftp::resolve_remote_file_jump};

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

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileJump {
    directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned_file: Option<String>,
}

pub(crate) fn expand_jump_path(
    path: String,
    home: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if path.starts_with('/') {
        return Ok(path);
    }
    if path == "~" || path.starts_with("~/") {
        let home = home()?;
        if home.starts_with('/') {
            return Ok(home + &path[1..]);
        }
    }
    Err("expected an absolute or home-relative path".into())
}

pub(crate) async fn resolve_file_jump<T, R, C, E>(
    path: String,
    read_dir: impl Fn(String, bool) -> R,
    entry_parts: impl Fn(&T) -> (&str, bool),
    canonicalize: impl Fn(String) -> C,
    exists: impl FnOnce(String) -> E,
) -> Result<FileJump, String>
where
    R: Future<Output = Result<Vec<T>, String>>,
    C: Future<Output = Result<String, String>>,
    E: Future<Output = bool>,
{
    if read_dir(path.clone(), false).await.is_ok() {
        return Ok(FileJump {
            directory: canonicalize(path).await?,
            pinned_file: None,
        });
    }

    let not_found = || "file or directory not found".to_string();
    let (parent, name) = path.rsplit_once('/').ok_or_else(not_found)?;
    if matches!(name, "" | "." | "..") {
        return Err(not_found());
    }
    let parent = if parent.is_empty() { "/" } else { parent }.to_string();
    let siblings = read_dir(parent.clone(), name.starts_with('.')).await?;
    let (listed_name, is_directory) = if let Some(exact) = siblings
        .iter()
        .map(&entry_parts)
        .find(|(listed, _)| *listed == name)
    {
        exact
    } else {
        let folded = name.to_lowercase();
        let mut matches = siblings
            .iter()
            .map(&entry_parts)
            .filter(|(listed, _)| listed.to_lowercase() == folded);
        let matched = matches.next().ok_or_else(not_found)?;
        if matches.next().is_some() {
            return Err(not_found());
        }
        matched
    };
    if is_directory {
        return Err(not_found());
    }
    let directory = canonicalize(parent).await?;
    if listed_name != name && !exists(format!("{}/{name}", directory.trim_end_matches('/'))).await {
        return Err(not_found());
    }
    Ok(FileJump {
        directory,
        pinned_file: Some(listed_name.to_string()),
    })
}

#[tauri::command]
pub async fn fs_resolve_file_jump(
    state: tauri::State<'_, PtyState>,
    path: String,
    id: Option<u32>,
    binding: Option<SessionBindingV1>,
) -> Result<FileJump, String> {
    match id {
        Some(id) => resolve_remote_file_jump(state, id, path, binding).await,
        None => resolve_local_file_jump(path, || fs_resolve_dir("~".into())).await,
    }
}

async fn resolve_local_file_jump(
    path: String,
    home: impl FnOnce() -> Result<String, String>,
) -> Result<FileJump, String> {
    resolve_file_jump(
        expand_jump_path(path, home)?,
        |path, hidden| ready(fs_read_dir(path, Some(hidden))),
        |entry| (&entry.name, matches!(entry.kind, EntryKind::Dir)),
        |path| ready(canonical_path(&path)),
        |path| ready(canonical_path(&path).is_ok()),
    )
    .await
}

fn canonical_path(path: &str) -> Result<String, String> {
    Path::new(path)
        .canonicalize()
        .map_err(|error| error.to_string())?
        .into_os_string()
        .into_string()
        .map_err(|_| "canonical path is not UTF-8".into())
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
    use super::{resolve_dir_with, resolve_file_jump, FileJump};
    use crate::modules::util::expand_tilde_with;
    use std::future::ready;
    use std::path::Path;

    #[cfg(unix)]
    #[tokio::test]
    async fn file_jump_resolves_local_paths_in_filesystem_order() {
        use std::fs;
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("tunara-canonical-path-{}", std::process::id()));
        fs::create_dir_all(root.join("source")).unwrap();
        fs::create_dir_all(root.join("target/child")).unwrap();
        fs::write(root.join("target/readme.md"), "").unwrap();
        fs::write(root.join("target/.notes"), "").unwrap();
        symlink(root.join("target/child"), root.join("source/link")).unwrap();
        let target = root
            .join("target")
            .canonicalize()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap();
        let absolute = |path: &str| root.join(path).into_os_string().into_string().unwrap();
        let resolve = |path| super::resolve_local_file_jump(path, || Ok(absolute("")));
        let directory = resolve(absolute("source/link/..")).await;
        let file = resolve(absolute("source/link/../readme.md")).await;
        let hidden = resolve("~/target/.notes".into()).await;
        let home = resolve("~".into()).await;
        let missing = resolve(absolute("missing/../target")).await;
        let missing_file = resolve(absolute("missing/../target/readme.md")).await;
        let canonical_root = root
            .canonicalize()
            .unwrap()
            .into_os_string()
            .into_string()
            .unwrap();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            directory.unwrap(),
            FileJump {
                directory: target.clone(),
                pinned_file: None
            }
        );
        assert_eq!(
            file.unwrap(),
            FileJump {
                directory: target.clone(),
                pinned_file: Some("readme.md".into())
            }
        );
        assert_eq!(
            hidden.unwrap(),
            FileJump {
                directory: target,
                pinned_file: Some(".notes".into())
            }
        );
        assert_eq!(
            home.unwrap(),
            FileJump {
                directory: canonical_root,
                pinned_file: None
            }
        );
        assert!(missing.is_err());
        assert!(missing_file.is_err());
    }

    #[tokio::test]
    async fn file_jump_prefers_exact_case_and_requires_existing_unambiguous_fallback() {
        let resolve = |name, typed_path_exists| {
            resolve_file_jump(
                format!("/alias/{name}"),
                |path, _| {
                    ready(if path == "/alias" {
                        Ok(vec!["Readme.md", "Title.ts", "title.ts"])
                    } else {
                        Err("not a directory".into())
                    })
                },
                |entry| (entry, false),
                |path| {
                    assert_eq!(path, "/alias");
                    ready(Ok("/canonical".into()))
                },
                move |path| {
                    assert_eq!(path, "/canonical/README.md");
                    ready(typed_path_exists)
                },
            )
        };
        assert!(resolve("README.md", false).await.is_err());
        assert_eq!(
            resolve("README.md", true)
                .await
                .unwrap()
                .pinned_file
                .as_deref(),
            Some("Readme.md")
        );
        assert!(resolve("TITLE.ts", true).await.is_err());
        assert_eq!(
            resolve("Title.ts", false)
                .await
                .unwrap()
                .pinned_file
                .as_deref(),
            Some("Title.ts")
        );
    }

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
