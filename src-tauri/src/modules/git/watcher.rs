//! Git 文件监听：替换前端 1500ms 节流轮询，agent 改动秒级感知。
//!
//! 设计要点：
//! - 一个 repo_path 一个 watcher，引用计数支持多 session 复用同仓库
//! - 用 notify-debouncer-mini 300ms 去抖，避免 IDE 写 index 风暴
//! - 过滤 `.git/objects/`、`.git/index.lock`、`node_modules/` 等高噪声路径
//! - 事件通过 `git-changed` event 推前端，payload 含 repoPath

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use git2::Repository;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::modules::util::expand_tilde;

type DebouncerHandle = Debouncer<notify::RecommendedWatcher>;

struct WatcherEntry {
    refcount: usize,
    _debouncer: DebouncerHandle,
}

/// Cached git_status result keyed by the original repo_path string.
/// Invalidated by the file watcher and a safety-net TTL.
pub struct CachedStatus {
    pub status: super::StatusResult,
    pub expiry: Instant,
}

pub struct CachedWorkspace {
    pub workspace: super::workspace::WorkspaceContext,
    pub expiry: Instant,
}

#[derive(Default)]
pub struct GitWatcherState {
    inner: Mutex<HashMap<PathBuf, WatcherEntry>>,
    /// git_status cache: repo_path string -> (result, expiry).
    pub status_cache: Mutex<HashMap<String, CachedStatus>>,
    /// Workspace/worktree discovery cache. It is invalidated alongside status
    /// because branch, dirty state and linked-worktree metadata share Git's
    /// watcher surface.
    pub workspace_cache: Mutex<HashMap<String, CachedWorkspace>>,
}

#[derive(Serialize, Clone)]
struct GitChangedPayload<'a> {
    #[serde(rename = "repoPath")]
    repo_path: &'a str,
}

fn is_noisy_path(path: &Path, worktree: &Path, common_git_dir: Option<&Path>) -> bool {
    let (relative, mut previous_is_git_dir) = if let Ok(relative) = path.strip_prefix(worktree) {
        (relative, false)
    } else if let Some(relative) = common_git_dir.and_then(|dir| path.strip_prefix(dir).ok()) {
        (relative, true)
    } else {
        return false;
    };

    let mut parts = relative.iter().peekable();
    while let Some(part) = parts.next() {
        let noisy = if parts.peek().is_some() {
            part == "node_modules"
                || part == "target"
                || part == "dist"
                || (previous_is_git_dir && (part == "objects" || part == "lfs"))
        } else {
            previous_is_git_dir && (part == "index.lock" || part == "HEAD.lock")
        };
        if noisy || part.to_string_lossy().starts_with(".DS_Store") {
            return true;
        }
        previous_is_git_dir = part == ".git";
    }
    false
}

fn watch_target(expanded: &str) -> Result<PathBuf, String> {
    let path = Path::new(expanded)
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", expanded, e))?;
    let repo = Repository::discover(&path).ok();
    match repo.as_ref().and_then(Repository::workdir) {
        Some(workdir) => workdir
            .canonicalize()
            .map_err(|e| format!("canonicalize {}: {}", workdir.display(), e)),
        None => Ok(path),
    }
}

#[tauri::command]
pub fn git_watch(
    repo_path: String,
    app: AppHandle,
    state: State<'_, GitWatcherState>,
) -> Result<(), String> {
    // The map key is the caller's original repo_path so the frontend can dedup
    // and unwatch using the exact same string it sent. The actual watcher
    // target needs an absolute path, which we resolve separately.
    let key = PathBuf::from(&repo_path);
    let expanded = expand_tilde(&repo_path);
    let watch_target = watch_target(&expanded)?;

    let mut map = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = map.get_mut(&key) {
        entry.refcount += 1;
        return Ok(());
    }

    // Linked worktrees keep Git metadata outside the checkout. Watch and
    // filter that tree separately so branch and worktree changes still refresh.
    let common_git_dir = Repository::discover(&expanded)
        .ok()
        .and_then(|repo| super::workspace::common_git_dir(&repo).ok())
        .filter(|dir| !dir.starts_with(&watch_target));
    let filter_root = watch_target.clone();
    let filter_git_dir = common_git_dir.clone();
    let app_handle = app.clone();
    let emit_path = repo_path.clone();
    let cache_app = app.clone();
    // Normalize identically to git_status's cache key so invalidation always
    // hits the entry it stored (guards against an un-normalized repo_path).
    let cache_path = super::status_cache_key(&repo_path);

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(_) => return,
            };
            if events
                .iter()
                .all(|e| is_noisy_path(&e.path, &filter_root, filter_git_dir.as_deref()))
            {
                return;
            }
            // Invalidate the git_status cache for this repo so the next
            // git_status call does a fresh diff instead of returning stale data.
            if let Some(state) = cache_app.try_state::<GitWatcherState>() {
                if let Ok(mut cache) = state.status_cache.lock() {
                    cache.remove(&cache_path);
                }
                if let Ok(mut cache) = state.workspace_cache.lock() {
                    cache.clear();
                }
            }
            let _ = app_handle.emit(
                "git-changed",
                GitChangedPayload {
                    repo_path: &emit_path,
                },
            );
        },
    )
    .map_err(|e| format!("create debouncer: {}", e))?;

    debouncer
        .watcher()
        .watch(&watch_target, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {}", watch_target.display(), e))?;

    if let Some(dir) = common_git_dir {
        debouncer
            .watcher()
            .watch(&dir, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {}", dir.display(), e))?;
    }

    map.insert(
        key,
        WatcherEntry {
            refcount: 1,
            _debouncer: debouncer,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn git_unwatch(repo_path: String, state: State<'_, GitWatcherState>) -> Result<(), String> {
    let key = PathBuf::from(&repo_path);
    let mut map = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = map.get_mut(&key) {
        if entry.refcount > 1 {
            entry.refcount -= 1;
        } else {
            map.remove(&key);
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn shutdown_all(app: &AppHandle) {
    if let Some(state) = app.try_state::<GitWatcherState>() {
        if let Ok(mut map) = state.inner.lock() {
            map.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_noisy_path, watch_target};
    use git2::Repository;
    use std::path::Path;

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "tunara-git-watch-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn watch_target_covers_repo_edits_outside_terminal_subdirectory() {
        let root = TestDir::new();
        Repository::init(&root.0).unwrap();
        let subdir = root.0.join("terminal/subdir");
        std::fs::create_dir_all(&subdir).unwrap();
        assert_eq!(watch_target(subdir.to_str().unwrap()).unwrap(), root.0);
    }

    #[test]
    fn watch_target_keeps_repo_root() {
        let root = TestDir::new();
        Repository::init(&root.0).unwrap();
        assert_eq!(watch_target(root.0.to_str().unwrap()).unwrap(), root.0);
    }

    #[test]
    fn watch_target_keeps_non_repo_directory() {
        let root = TestDir::new();
        assert_eq!(watch_target(root.0.to_str().unwrap()).unwrap(), root.0);
    }

    #[test]
    fn watch_target_rejects_missing_path() {
        let root = TestDir::new();
        Repository::init(&root.0).unwrap();
        assert!(watch_target(root.0.join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn is_noisy_path_flags_git_internal_and_build_dirs() {
        // High-churn paths that must NOT trigger a git-status refresh.
        let root = Path::new("/repo");
        let noisy = [
            "/repo/.git/objects/ab/cdef",
            "/repo/.git/lfs/objects/00",
            "/repo/.git/index.lock",
            "/repo/.git/HEAD.lock",
            "/repo/node_modules/pkg/index.js",
            "/repo/target/debug/build",
            "/repo/dist/bundle.js",
            "/repo/packages/web/dist/bundle.js",
            "/repo/.DS_Store",
            "/repo/sub/.DS_Store",
        ];
        for p in noisy {
            assert!(
                is_noisy_path(Path::new(p), root, None),
                "{p} should be noisy"
            );
        }
    }

    #[test]
    fn is_noisy_path_allows_real_source_changes() {
        // Real edits that SHOULD trigger a refresh.
        let root = Path::new("/repo");
        let clean = [
            "/repo/src/main.rs",
            "/repo/README.md",
            "/repo/.gitignore",
            "/repo/.github/workflows/ci.yml",
            "/repo/lib/dist-helper.rs", // contains "dist" but not "/dist/"
            "/repo/my-node_modules-notes.md",
        ];
        for p in clean {
            assert!(
                !is_noisy_path(Path::new(p), root, None),
                "{p} should be clean"
            );
        }
    }

    #[test]
    fn is_noisy_path_allows_edits_below_noisy_named_ancestors() {
        for dir in ["dist", "target", "node_modules"] {
            let root = Path::new("/checkout").join(dir).join("repo");
            let source = root.join("src/main.rs");
            assert!(
                !is_noisy_path(&source, &root, None),
                "{source:?} should be clean"
            );
            let artifact = root.join(dir).join("artifact");
            assert!(
                is_noisy_path(&artifact, &root, None),
                "{artifact:?} should be noisy"
            );
        }
    }

    #[test]
    fn is_noisy_path_lock_match_is_anchored_to_the_git_dir() {
        // index.lock anywhere else (not under .git) is a normal file.
        let root = Path::new("/repo");
        assert!(!is_noisy_path(&root.join("src/index.lock"), root, None));
        assert!(is_noisy_path(&root.join(".git/index.lock"), root, None));
    }

    #[test]
    fn is_noisy_path_preserves_linked_worktree_metadata_refresh() {
        let root = Path::new("/checkout/linked");
        let common = Path::new("/checkout/target/main/.git");
        for path in [
            "objects/ab/cdef",
            "lfs/objects/00",
            "index.lock",
            "HEAD.lock",
        ] {
            assert!(
                is_noisy_path(&common.join(path), root, Some(common)),
                "{path} should be noisy"
            );
        }
        for path in [
            "refs/heads/main",
            "worktrees/linked/HEAD",
            "worktrees/linked/index",
        ] {
            assert!(
                !is_noisy_path(&common.join(path), root, Some(common)),
                "{path} should be clean"
            );
        }
    }
}
