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
use std::time::Duration;

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

#[derive(Default)]
pub struct GitWatcherState {
    inner: Mutex<HashMap<PathBuf, WatcherEntry>>,
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
