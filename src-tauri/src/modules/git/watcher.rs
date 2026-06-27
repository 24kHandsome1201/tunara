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

#[derive(Default)]
pub struct GitWatcherState {
    inner: Mutex<HashMap<PathBuf, WatcherEntry>>,
    /// git_status cache: repo_path string -> (result, expiry).
    pub status_cache: Mutex<HashMap<String, CachedStatus>>,
}

#[derive(Serialize, Clone)]
struct GitChangedPayload<'a> {
    #[serde(rename = "repoPath")]
    repo_path: &'a str,
}

fn is_noisy_path(path: &Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("/.git/objects/")
        || s.contains("/.git/lfs/")
        || s.ends_with("/.git/index.lock")
        || s.ends_with("/.git/HEAD.lock")
        || s.contains("/node_modules/")
        || s.contains("/target/")
        || s.contains("/dist/")
        || s.contains("/.DS_Store")
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
    let watch_target = Path::new(&expanded)
        .canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", expanded, e))?;

    let mut map = state.inner.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = map.get_mut(&key) {
        entry.refcount += 1;
        return Ok(());
    }

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
            if events.iter().all(|e| is_noisy_path(&e.path)) {
                return;
            }
            // Invalidate the git_status cache for this repo so the next
            // git_status call does a fresh diff instead of returning stale data.
            if let Some(state) = cache_app.try_state::<GitWatcherState>() {
                if let Ok(mut cache) = state.status_cache.lock() {
                    cache.remove(&cache_path);
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
    use super::is_noisy_path;
    use std::path::Path;

    #[test]
    fn is_noisy_path_flags_git_internal_and_build_dirs() {
        // High-churn paths that must NOT trigger a git-status refresh.
        let noisy = [
            "/repo/.git/objects/ab/cdef",
            "/repo/.git/lfs/objects/00",
            "/repo/.git/index.lock",
            "/repo/.git/HEAD.lock",
            "/repo/node_modules/pkg/index.js",
            "/repo/target/debug/build",
            "/repo/dist/bundle.js",
            "/repo/.DS_Store",
            "/repo/sub/.DS_Store",
        ];
        for p in noisy {
            assert!(is_noisy_path(Path::new(p)), "{p} should be noisy");
        }
    }

    #[test]
    fn is_noisy_path_allows_real_source_changes() {
        // Real edits that SHOULD trigger a refresh.
        let clean = [
            "/repo/src/main.rs",
            "/repo/README.md",
            "/repo/.gitignore",
            "/repo/.github/workflows/ci.yml",
            "/repo/lib/dist-helper.rs", // contains "dist" but not "/dist/"
            "/repo/my-node_modules-notes.md",
        ];
        for p in clean {
            assert!(!is_noisy_path(Path::new(p)), "{p} should be clean");
        }
    }

    #[test]
    fn is_noisy_path_lock_match_is_anchored_to_the_git_dir() {
        // index.lock anywhere else (not under .git) is a normal file.
        assert!(!is_noisy_path(Path::new("/repo/src/index.lock")));
        assert!(is_noisy_path(Path::new("/repo/.git/index.lock")));
    }
}
