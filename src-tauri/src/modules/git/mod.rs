//! Git 集成：读操作（实施文档 §3.4.1）。
//!
//! `git_status` / `git_diff` / `git_ahead_behind` 用 git2 做结构化读取，不 spawn 子进程。
//! 写操作（commit/push）在 [`commit`] 模块里走系统 `git` CLI（D4）。
//!
//! 关键设计：
//! - `diff_tree_to_workdir_with_index` 覆盖 staged + unstaged + untracked（修 P1）。
//! - `diff.foreach` 先 file_cb 登记再 line_cb 累计，不漏零行变更（修 P2-15）。
//! - `FileDiff` 结构化：text / binary / tooLarge / metadataOnly（修 P1-13）。
//! - `RemoteState` 结构化降级：无 upstream / detached / unborn 不连累文件列表（修 P1-10）。

#[cfg(test)]
mod commit;

use std::cell::RefCell;
use std::collections::HashMap;

use git2::{Delta, DiffOptions, Repository};
use serde::Serialize;

use crate::modules::util::expand_tilde;

// ── git_status ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    pub added: usize,
    pub removed: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub branch: String,
    pub files: Vec<FileChange>,
    pub summary: String,
}

#[tauri::command]
pub fn git_status(repo_path: String, baseline: Option<String>) -> Result<StatusResult, String> {
    let repo_path = expand_tilde(&repo_path);
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .unwrap_or_else(|| "HEAD".into());

    // base tree → workdir（经 index），含 untracked，覆盖 staged+unstaged 全部改动。
    // baseline 为 None 时 base 取 HEAD（全部改动）；给定快照 tree oid 时只看自快照以来的改动。
    let base_tree = resolve_base_tree(&repo, baseline.as_deref());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(base_tree.as_ref(), Some(&mut opts))
        .map_err(|e| e.to_string())?;

    // 修 P2-15：先 file_cb 登记每个 delta（保证零行变更也在列表里），再 line_cb 累计。
    // RefCell 让 file_cb 和 line_cb 共享可变访问（git2 foreach 同时要两个 &mut FnMut）。
    let per_file: RefCell<HashMap<String, (usize, usize, char)>> = RefCell::new(HashMap::new());
    diff.foreach(
        &mut |delta, _progress| {
            let path = delta_path(&delta);
            per_file
                .borrow_mut()
                .entry(path)
                .or_insert((0, 0, delta_mark(&delta)));
            true
        },
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta_path(&delta);
            let mut map = per_file.borrow_mut();
            let e = map.entry(path).or_insert((0, 0, delta_mark(&delta)));
            match line.origin() {
                '+' => e.0 += 1,
                '-' => e.1 += 1,
                _ => {}
            }
            true
        }),
    )
    .map_err(|e| e.to_string())?;

    let mut files: Vec<FileChange> = per_file
        .into_inner()
        .into_iter()
        .map(|(path, (added, removed, mark))| FileChange {
            path,
            status: mark.to_string(),
            added,
            removed,
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let (ta, tr): (usize, usize) = files
        .iter()
        .fold((0, 0), |(a, r), f| (a + f.added, r + f.removed));
    let summary = format!("{} 文件 · +{} −{}", files.len(), ta, tr);
    Ok(StatusResult {
        branch,
        files,
        summary,
    })
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

#[tauri::command]
pub fn git_diff(
    repo_path: String,
    file: String,
    baseline: Option<String>,
) -> Result<FileDiff, String> {
    let repo_path = expand_tilde(&repo_path);
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let base_tree = resolve_base_tree(&repo, baseline.as_deref());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).pathspec(&file);
    let diff = repo
        .diff_tree_to_workdir_with_index(base_tree.as_ref(), Some(&mut opts))
        .map_err(|e| e.to_string())?;

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
        if out.len() >= DIFF_MAX_BYTES || lines >= DIFF_MAX_LINES {
            truncated = true;
            return true;
        }
        let origin = l.origin();
        if matches!(origin, '+' | '-' | ' ') {
            out.push(origin);
            lines += 1;
        }
        out.push_str(std::str::from_utf8(l.content()).unwrap_or(""));
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

// ── git_snapshot_baseline ───────────────────────────────────────────────

/// 把当前工作区快照成一个 tree，返回其 oid（十六进制）。
///
/// 用途：agent 启动瞬间记一个「改动基线」，之后 `git_status` / `git_diff`
/// 传入该 oid，就只显示「自 agent 启动以来」的改动，而非工作区里全部未提交改动。
///
/// 实现：把工作区（遵守 .gitignore）加进 repo 的**内存** index 再 `write_tree`，
/// 全程不调用 `index.write()`，磁盘上的 index 不受影响；只在 odb 里留下
/// 可被 GC 的松散对象。
#[tauri::command]
pub fn git_snapshot_baseline(repo_path: String) -> Result<String, String> {
    let repo_path = expand_tilde(&repo_path);
    let repo = Repository::discover(&repo_path).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    Ok(tree_oid.to_string())
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

/// 解析 diff 的 base tree：给定可解析的快照 oid 时用快照，否则回退到 HEAD。
fn resolve_base_tree<'r>(repo: &'r Repository, baseline: Option<&str>) -> Option<git2::Tree<'r>> {
    if let Some(oid_hex) = baseline {
        if let Ok(oid) = git2::Oid::from_str(oid_hex) {
            if let Ok(tree) = repo.find_tree(oid) {
                return Some(tree);
            }
        }
    }
    repo.head().ok().and_then(|h| h.peel_to_tree().ok())
}

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
        Delta::Added | Delta::Untracked => 'A',
        Delta::Deleted => 'D',
        Delta::Renamed => 'R',
        _ => 'M',
    }
}
