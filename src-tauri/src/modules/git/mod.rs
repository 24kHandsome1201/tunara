//! Git 集成：读操作（实施文档 §3.4.1）。
//!
//! `git_status` / `git_diff` / `git_ahead_behind` 用 git2 做结构化读取，不 spawn 子进程。
//! `commit` 模块只在 `cfg(test)` 下保留旧写路径的 pathspec 回归 fixture，不暴露 Tauri IPC。
//!
//! 关键设计：
//! - `git_status` 两步 diff：`diff_tree_to_index` (staged) + `diff_index_to_workdir` (unstaged/untracked)，带 stage 字段。
//! - `diff.foreach` 先 file_cb 登记再 line_cb 累计，不漏零行变更（修 P2-15）。
//! - `FileDiff` 结构化：text / binary / tooLarge / metadataOnly（修 P1-13）。
//! - `RemoteState` 结构化降级：无 upstream / detached / unborn 不连累文件列表（修 P1-10）。

#[cfg(test)]
mod commit;

pub mod watcher;
pub mod workspace;
pub use watcher::GitWatcherState;

use std::cell::RefCell;
use std::collections::HashMap;

use git2::{Delta, Diff, DiffOptions, Repository, Tree};
use serde::Serialize;
use tauri::State;

use crate::modules::util::expand_tilde;

// ── git_status ──────────────────────────────────────────────────────────

/// Safety-net TTL for the git_status cache. The file watcher invalidates
/// proactively, so this is only a backstop for missed/dropped watcher events.
/// Kept short so any invalidation miss self-heals quickly (the old code had no
/// cache and was always fresh; this trades a tiny staleness window for skipping
/// redundant diffs on rapid same-repo session switches).
const STATUS_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// Normalize a repo path for use as the status-cache key. Must stay byte-for-byte
/// identical to the frontend `normalizeRepoPath` (src/modules/git/lib/path-normalize.ts)
/// AND to the key the watcher invalidates under, or proactive invalidation silently
/// misses (e.g. a dir spelled with a trailing slash would never be invalidated).
pub(crate) fn status_cache_key(repo_path: &str) -> String {
    let without_trailing_slashes = repo_path.trim_end_matches('/');
    if without_trailing_slashes.is_empty() && repo_path.starts_with('/') {
        "/".to_string()
    } else {
        without_trailing_slashes.to_string()
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub stage: String,
    pub added: usize,
    pub removed: usize,
}

/// Status payload for the review rail. Deliberately carries no display string:
/// the localized summary line is composed on the frontend from `files` (see
/// DiffPanel), so the backend never bakes a UI language into IPC data.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub branch: String,
    pub files: Vec<FileChange>,
}

struct FileChangeAccumulator {
    added: usize,
    removed: usize,
    mark: char,
    stage: &'static str,
}

#[tauri::command]
pub fn git_status(
    repo_path: String,
    cache_state: State<'_, GitWatcherState>,
) -> Result<StatusResult, String> {
    // Normalize so the cache key matches the key the watcher invalidates under
    // (which comes from the frontend's normalizeRepoPath). Without this, a dir
    // passed here with a trailing slash would cache under a key the watcher
    // never removes → stale status until the TTL expires.
    let cache_key = status_cache_key(&repo_path);

    // Check cache: serves rapid session switches in the same repo without
    // re-running two full git diffs. Invalidated by the file watcher.
    {
        if let Ok(cache) = cache_state.status_cache.lock() {
            if let Some(entry) = cache.get(&cache_key) {
                if entry.expiry > std::time::Instant::now() {
                    return Ok(entry.status.clone());
                }
            }
        }
    }

    let repo_path_expanded = expand_tilde(&repo_path);
    let repo = Repository::discover(&repo_path_expanded).map_err(|e| e.to_string())?;
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .unwrap_or_else(|| "HEAD".into());

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    // Staged: HEAD tree → index（已暂存改动）
    let mut staged_opts = DiffOptions::new();
    let staged_diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut staged_opts))
        .map_err(|e| e.to_string())?;
    let mut files = collect_diff(&staged_diff, true)?;

    // Unstaged + untracked: index → workdir（未暂存 + 未追踪）
    let mut unstaged_opts = DiffOptions::new();
    unstaged_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true);
    let unstaged_diff = repo
        .diff_index_to_workdir(None, Some(&mut unstaged_opts))
        .map_err(|e| e.to_string())?;
    files.extend(collect_diff(&unstaged_diff, false)?);

    files.sort_by(|a, b| a.path.cmp(&b.path).then(a.stage.cmp(&b.stage)));

    let result = StatusResult { branch, files };

    // Store in cache for rapid session switches in the same repo.
    if let Ok(mut cache) = cache_state.status_cache.lock() {
        cache.insert(
            cache_key,
            watcher::CachedStatus {
                status: result.clone(),
                expiry: std::time::Instant::now() + STATUS_CACHE_TTL,
            },
        );
    }

    Ok(result)
}

/// 从 diff 收集 FileChange，`is_staged_diff` 区分是 staged (HEAD→index) 还是
/// unstaged (index→workdir) diff。后者中 Untracked delta 归类为 "untracked"。
fn collect_diff(diff: &git2::Diff, is_staged_diff: bool) -> Result<Vec<FileChange>, String> {
    let per_file: RefCell<HashMap<String, FileChangeAccumulator>> = RefCell::new(HashMap::new());
    diff.foreach(
        &mut |delta, _progress| {
            let path = delta_path(&delta);
            let stage = stage_for_delta(&delta, is_staged_diff);
            per_file
                .borrow_mut()
                .entry(path)
                .or_insert(FileChangeAccumulator {
                    added: 0,
                    removed: 0,
                    mark: delta_mark(&delta),
                    stage,
                });
            true
        },
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta_path(&delta);
            let stage = stage_for_delta(&delta, is_staged_diff);
            let mut map = per_file.borrow_mut();
            let e = map.entry(path).or_insert(FileChangeAccumulator {
                added: 0,
                removed: 0,
                mark: delta_mark(&delta),
                stage,
            });
            match line.origin() {
                '+' => e.added += 1,
                '-' => e.removed += 1,
                _ => {}
            }
            true
        }),
    )
    .map_err(|e| e.to_string())?;

    Ok(per_file
        .into_inner()
        .into_iter()
        .map(|(path, change)| FileChange {
            path,
            status: change.mark.to_string(),
            stage: change.stage.to_string(),
            added: change.added,
            removed: change.removed,
        })
        .collect())
}

fn stage_for_delta(delta: &git2::DiffDelta, is_staged_diff: bool) -> &'static str {
    if is_staged_diff {
        "staged"
    } else if delta.status() == Delta::Untracked {
        "untracked"
    } else {
        "unstaged"
    }
}

// ── git_diff ────────────────────────────────────────────────────────────

const DIFF_MAX_BYTES: usize = 256 * 1024; // 单文件 patch 上限
const DIFF_MAX_LINES: usize = 2000; // 单文件行数上限

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileDiff {
    Text {
        path: String,
        patch: String,
        truncated: bool,
        total_lines: usize,
    },
    Binary {
        path: String,
    },
    TooLarge {
        path: String,
        bytes: usize,
    },
    MetadataOnly {
        path: String,
        change: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiffScope {
    Combined,
    Staged,
    Unstaged,
    Untracked,
}

impl DiffScope {
    fn from_stage(stage: Option<&str>) -> Self {
        match stage {
            Some("staged") => Self::Staged,
            Some("unstaged") => Self::Unstaged,
            Some("untracked") => Self::Untracked,
            _ => Self::Combined,
        }
    }
}

#[tauri::command]
pub fn git_diff(
    repo_path: String,
    file: String,
    stage: Option<String>,
) -> Result<FileDiff, String> {
    let repo_path = expand_tilde(&repo_path);
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = scoped_file_diff(
        &repo,
        head_tree.as_ref(),
        &file,
        DiffScope::from_stage(stage.as_deref()),
    )?;

    file_diff_from_git_diff(diff, file)
}

fn scoped_file_diff<'repo>(
    repo: &'repo Repository,
    head_tree: Option<&Tree<'repo>>,
    file: &str,
    scope: DiffScope,
) -> Result<Diff<'repo>, String> {
    let mut opts = DiffOptions::new();
    opts.pathspec(file);
    match scope {
        DiffScope::Staged => repo.diff_tree_to_index(head_tree, None, Some(&mut opts)),
        DiffScope::Unstaged => repo.diff_index_to_workdir(None, Some(&mut opts)),
        DiffScope::Untracked => {
            opts.include_untracked(true).recurse_untracked_dirs(true);
            repo.diff_index_to_workdir(None, Some(&mut opts))
        }
        DiffScope::Combined => {
            opts.include_untracked(true).recurse_untracked_dirs(true);
            repo.diff_tree_to_workdir_with_index(head_tree, Some(&mut opts))
        }
    }
    .map_err(|e| e.to_string())
}

fn file_diff_from_git_diff(diff: Diff<'_>, file: String) -> Result<FileDiff, String> {
    // 先看 delta：二进制 / 纯 metadata 直接短路
    if let Some(delta) = diff.deltas().next() {
        if delta.flags().is_binary() {
            return Ok(FileDiff::Binary { path: file });
        }
        match delta.status() {
            Delta::Renamed => {
                return Ok(FileDiff::MetadataOnly {
                    path: file,
                    change: "rename".into(),
                })
            }
            Delta::Typechange => {
                return Ok(FileDiff::MetadataOnly {
                    path: file,
                    change: "mode".into(),
                })
            }
            _ => {}
        }
    }

    let mut out = String::new();
    let mut lines = 0usize;
    let mut truncated = false;
    diff.print(git2::DiffFormat::Patch, |_d, _h, l| {
        let content = std::str::from_utf8(l.content()).unwrap_or("");
        let origin = l.origin();
        let prefix_len = if matches!(origin, '+' | '-' | ' ') {
            1
        } else {
            0
        };
        if out.len() + content.len() + prefix_len > DIFF_MAX_BYTES || lines >= DIFF_MAX_LINES {
            truncated = true;
            return true;
        }
        if prefix_len == 1 {
            out.push(origin);
            lines += 1;
        }
        out.push_str(content);
        true
    })
    .map_err(|e| e.to_string())?;

    if truncated && out.len() >= DIFF_MAX_BYTES {
        return Ok(FileDiff::TooLarge {
            path: file,
            bytes: out.len(),
        });
    }
    Ok(FileDiff::Text {
        path: file,
        patch: out,
        truncated,
        total_lines: lines,
    })
}

// ── git_ahead_behind ────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RemoteState {
    Ok {
        upstream: String,
        ahead: usize,
        behind: usize,
    },
    NoUpstream {
        branch: String,
    },
    Detached {
        oid: String,
    },
    Unborn,
    Unknown {
        message: String,
    },
}

#[tauri::command]
pub fn git_ahead_behind(repo_path: String) -> Result<RemoteState, String> {
    let repo_path = expand_tilde(&repo_path);
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let head = match repo.head() {
        Ok(h) => h,
        Err(ref e) if e.code() == git2::ErrorCode::UnbornBranch => return Ok(RemoteState::Unborn),
        Err(e) => {
            return Ok(RemoteState::Unknown {
                message: e.to_string(),
            })
        }
    };
    if repo.head_detached().unwrap_or(false) {
        return Ok(RemoteState::Detached {
            oid: head.target().map(|o| o.to_string()).unwrap_or_default(),
        });
    }
    let local = match head.target() {
        Some(o) => o,
        None => return Ok(RemoteState::Unborn),
    };
    let branch = head.shorthand().unwrap_or("HEAD").to_string();
    let upstream = match repo
        .find_branch(&branch, git2::BranchType::Local)
        .and_then(|b| b.upstream())
    {
        Ok(u) => u,
        Err(_) => return Ok(RemoteState::NoUpstream { branch }),
    };
    let up_name = upstream.name().ok().flatten().unwrap_or("").to_string();
    let up_oid = match upstream.get().target() {
        Some(o) => o,
        None => return Ok(RemoteState::NoUpstream { branch }),
    };
    match repo.graph_ahead_behind(local, up_oid) {
        Ok((ahead, behind)) => Ok(RemoteState::Ok {
            upstream: up_name,
            ahead,
            behind,
        }),
        Err(e) => Ok(RemoteState::Unknown {
            message: e.to_string(),
        }),
    }
}

// ── helpers ─────────────────────────────────────────────────────────────

fn delta_path(delta: &git2::DiffDelta) -> String {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn delta_mark(delta: &git2::DiffDelta) -> char {
    match delta.status() {
        Delta::Untracked => '?',
        Delta::Added => 'A',
        Delta::Deleted => 'D',
        Delta::Renamed => 'R',
        _ => 'M',
    }
}

#[cfg(test)]
mod tests {
    use super::{git_diff, status_cache_key, DiffScope, FileDiff};
    use git2::{Repository, Signature};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepoDir {
        path: PathBuf,
    }

    impl TestRepoDir {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "tunara-git-test-{}-{}",
                std::process::id(),
                suffix
            ));
            std::fs::create_dir_all(&path).expect("create test repo dir");
            Self { path }
        }
    }

    impl Drop for TestRepoDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn commit_file(repo: &Repository, repo_dir: &Path, relative_path: &str, contents: &str) {
        std::fs::write(repo_dir.join(relative_path), contents).expect("write test file");
        let mut index = repo.index().expect("open repo index");
        index
            .add_path(Path::new(relative_path))
            .expect("add test file");
        index.write().expect("write repo index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let sig = Signature::now("Tunara Test", "test@example.com").expect("signature");
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .expect("commit test file");
    }

    fn text_patch(diff: FileDiff) -> String {
        match diff {
            FileDiff::Text { patch, .. } => patch,
            other => panic!("expected text diff, got {other:?}"),
        }
    }

    #[test]
    fn status_cache_key_strips_trailing_slashes() {
        // Must stay byte-for-byte identical to the frontend normalizeRepoPath:
        // a mismatch means a trailing-slash dir never gets its cache invalidated.
        assert_eq!(status_cache_key("/a/b"), "/a/b");
        assert_eq!(status_cache_key("/a/b/"), "/a/b");
        assert_eq!(status_cache_key("/a/b///"), "/a/b");
        assert_eq!(status_cache_key("/"), "/");
        assert_eq!(status_cache_key("////"), "/");
    }

    #[test]
    fn status_cache_key_leaves_non_trailing_slashes_intact() {
        assert_eq!(status_cache_key("/a/b/c"), "/a/b/c");
        assert_eq!(status_cache_key(""), "");
        assert_eq!(status_cache_key("/a/b "), "/a/b ");
    }

    #[test]
    fn diff_scope_tracks_frontend_file_stage() {
        assert_eq!(DiffScope::from_stage(Some("staged")), DiffScope::Staged);
        assert_eq!(DiffScope::from_stage(Some("unstaged")), DiffScope::Unstaged);
        assert_eq!(
            DiffScope::from_stage(Some("untracked")),
            DiffScope::Untracked
        );
        assert_eq!(DiffScope::from_stage(None), DiffScope::Combined);
        assert_eq!(DiffScope::from_stage(Some("unknown")), DiffScope::Combined);
    }

    #[test]
    fn git_diff_keeps_staged_and_unstaged_scopes_separate() {
        let dir = TestRepoDir::new();
        let repo = Repository::init(&dir.path).expect("init repo");
        commit_file(&repo, &dir.path, "file.txt", "base\n");

        std::fs::write(dir.path.join("file.txt"), "staged\n").expect("write staged file");
        let mut index = repo.index().expect("open repo index");
        index
            .add_path(Path::new("file.txt"))
            .expect("stage test file");
        index.write().expect("write staged index");
        std::fs::write(dir.path.join("file.txt"), "unstaged\n").expect("write unstaged file");

        let repo_path = dir.path.to_string_lossy().into_owned();
        let staged = text_patch(
            git_diff(repo_path.clone(), "file.txt".into(), Some("staged".into()))
                .expect("staged diff"),
        );
        let unstaged = text_patch(
            git_diff(repo_path, "file.txt".into(), Some("unstaged".into())).expect("unstaged diff"),
        );

        assert!(staged.contains("+staged"));
        assert!(!staged.contains("+unstaged"));
        assert!(unstaged.contains("-staged"));
        assert!(unstaged.contains("+unstaged"));
        assert!(!unstaged.contains("-base"));
    }
}
