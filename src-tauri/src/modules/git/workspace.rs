//! Read-only repository/worktree discovery for workspace-aware UI.
//!
//! Identity is rooted in Git's common directory, not the session cwd. This
//! keeps a repository stable across linked worktrees and symlinked paths while
//! still giving every checkout its own worktree identity.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use git2::{BranchType, Repository, StatusOptions, WorktreeLockStatus};
use serde::Serialize;
use tauri::State;

use super::status_cache_key;
use super::watcher::{CachedWorkspace, GitWatcherState};
use crate::modules::util::expand_tilde;

const WORKSPACE_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRef {
    pub id: String,
    pub name: String,
    pub common_git_dir: String,
    pub transport: String,
    pub host: Option<String>,
    pub bare: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    /// `None` means the transport did not prove dirty state. Never render it
    /// as clean: remote discovery intentionally degrades honestly.
    pub dirty_files: Option<usize>,
    pub upstream: Option<String>,
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    pub current: bool,
    pub locked: bool,
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub repository: RepositoryRef,
    pub current_worktree_id: Option<String>,
    pub worktrees: Vec<WorktreeRef>,
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

pub(crate) fn common_git_dir(repo: &Repository) -> Result<PathBuf, String> {
    let git_dir = canonical_or_original(repo.path());
    let marker = git_dir.join("commondir");
    if !marker.is_file() {
        return Ok(git_dir);
    }

    let raw = fs::read_to_string(&marker).map_err(|e| format!("read {}: {e}", marker.display()))?;
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("{} is empty", marker.display()));
    }
    let candidate = Path::new(value);
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        git_dir.join(candidate)
    };
    Ok(canonical_or_original(&resolved))
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("repository")
        .to_string()
}

fn dirty_file_count(repo: &Repository) -> usize {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    repo.statuses(Some(&mut opts)).map(|s| s.len()).unwrap_or(0)
}

fn upstream_state(
    repo: &Repository,
    branch_name: Option<&str>,
) -> (Option<String>, Option<usize>, Option<usize>) {
    let Some(branch_name) = branch_name else {
        return (None, None, None);
    };
    let Ok(branch) = repo.find_branch(branch_name, BranchType::Local) else {
        return (None, None, None);
    };
    let Ok(upstream) = branch.upstream() else {
        return (None, None, None);
    };
    let upstream_name = upstream.name().ok().flatten().map(str::to_string);
    let local_oid = branch.get().target();
    let upstream_oid = upstream.get().target();
    let counts = local_oid
        .zip(upstream_oid)
        .and_then(|(local, remote)| repo.graph_ahead_behind(local, remote).ok());
    (
        upstream_name,
        counts.map(|(ahead, _)| ahead),
        counts.map(|(_, behind)| behind),
    )
}

fn worktree_from_path(
    repository_id: &str,
    path: PathBuf,
    current_path: Option<&Path>,
    locked: bool,
    validation_error: Option<String>,
) -> WorktreeRef {
    let canonical = canonical_or_original(&path);
    let path_string = canonical.to_string_lossy().into_owned();
    let current = current_path.is_some_and(|value| value == canonical);
    let name = display_name(&canonical);
    let id = format!("{repository_id}::{path_string}");

    match Repository::open(&canonical) {
        Ok(repo) => {
            let head = repo.head().ok();
            let detached = repo.head_detached().unwrap_or(false);
            let branch = head
                .as_ref()
                .and_then(|reference| reference.shorthand())
                .map(str::to_string)
                .filter(|_| !detached);
            let oid = head
                .and_then(|reference| reference.target())
                .map(|oid| oid.to_string());
            let (upstream, ahead, behind) = upstream_state(&repo, branch.as_deref());
            WorktreeRef {
                id,
                name,
                path: path_string,
                branch,
                head: oid,
                detached,
                dirty_files: Some(dirty_file_count(&repo)),
                upstream,
                ahead,
                behind,
                current,
                locked,
                available: validation_error.is_none(),
                error: validation_error,
            }
        }
        Err(error) => WorktreeRef {
            id,
            name,
            path: path_string,
            branch: None,
            head: None,
            detached: false,
            dirty_files: None,
            upstream: None,
            ahead: None,
            behind: None,
            current,
            locked,
            available: false,
            error: Some(validation_error.unwrap_or_else(|| error.to_string())),
        },
    }
}

pub(crate) fn discover_workspace(repo_path: &str) -> Result<WorkspaceContext, String> {
    let expanded = expand_tilde(repo_path);
    let current_repo = Repository::discover(&expanded).map_err(|e| e.to_string())?;
    let common_dir = common_git_dir(&current_repo)?;
    let common_dir_string = common_dir.to_string_lossy().into_owned();
    let repository_id = format!("local:{common_dir_string}");
    let main_repo = Repository::open(&common_dir).map_err(|e| e.to_string())?;
    let current_path = current_repo.workdir().map(canonical_or_original);

    let repository_name_path = main_repo
        .workdir()
        .map(canonical_or_original)
        .unwrap_or_else(|| common_dir.parent().unwrap_or(&common_dir).to_path_buf());
    let repository = RepositoryRef {
        id: repository_id.clone(),
        name: display_name(&repository_name_path),
        common_git_dir: common_dir_string,
        transport: "local".to_string(),
        host: None,
        bare: main_repo.is_bare(),
    };

    let mut paths = Vec::<(PathBuf, bool, Option<String>)>::new();
    if let Some(path) = main_repo.workdir() {
        paths.push((path.to_path_buf(), false, None));
    }
    if let Ok(names) = main_repo.worktrees() {
        for name in names.iter().flatten() {
            match main_repo.find_worktree(name) {
                Ok(worktree) => {
                    let error = worktree.validate().err().map(|e| e.to_string());
                    paths.push((
                        worktree.path().to_path_buf(),
                        matches!(worktree.is_locked(), Ok(WorktreeLockStatus::Locked(_))),
                        error,
                    ));
                }
                Err(error) => paths.push((
                    common_dir.join("worktrees").join(name),
                    false,
                    Some(error.to_string()),
                )),
            }
        }
    }

    // A malformed common-dir setup must not hide the checkout the user is
    // actually in. Add it explicitly if Git's registry omitted it.
    if let Some(path) = current_path.as_ref() {
        paths.push((path.clone(), false, None));
    }

    let mut seen = HashSet::new();
    let mut worktrees = paths
        .into_iter()
        .filter_map(|(path, locked, error)| {
            let key = canonical_or_original(&path);
            seen.insert(key.clone()).then(|| {
                worktree_from_path(&repository_id, key, current_path.as_deref(), locked, error)
            })
        })
        .collect::<Vec<_>>();
    worktrees.sort_by(|a, b| b.current.cmp(&a.current).then(a.path.cmp(&b.path)));
    let current_worktree_id = worktrees
        .iter()
        .find(|worktree| worktree.current)
        .map(|worktree| worktree.id.clone());

    Ok(WorkspaceContext {
        repository,
        current_worktree_id,
        worktrees,
    })
}

#[tauri::command]
pub async fn git_workspace_context(
    repo_path: String,
    cache_state: State<'_, GitWatcherState>,
) -> Result<WorkspaceContext, String> {
    let cache_key = status_cache_key(&repo_path);
    if let Ok(cache) = cache_state.workspace_cache.lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.expiry > Instant::now() {
                return Ok(entry.workspace.clone());
            }
        }
    }

    // Repository discovery can touch many linked worktree indexes. Keep that
    // blocking filesystem/libgit2 work off the async IPC executor so a large
    // repository cannot stall PTY input/output dispatch.
    let discovery_path = repo_path.clone();
    let workspace =
        tauri::async_runtime::spawn_blocking(move || discover_workspace(&discovery_path))
            .await
            .map_err(|e| format!("workspace discovery task failed: {e}"))??;
    log::info!(
        "git workspace discovered transport=local repository={} worktrees={} current={}",
        workspace.repository.name,
        workspace.worktrees.len(),
        workspace.current_worktree_id.is_some()
    );
    if let Ok(mut cache) = cache_state.workspace_cache.lock() {
        cache.insert(
            cache_key,
            CachedWorkspace {
                workspace: workspace.clone(),
                expiry: Instant::now() + WORKSPACE_CACHE_TTL,
            },
        );
    }
    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Signature;

    fn test_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tunara-workspace-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn init_repo(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        let mut index = repo.index().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = Signature::now("Tunara Test", "test@tunara.local").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repo
    }

    #[test]
    fn groups_main_and_linked_worktree_under_common_identity() {
        let root = test_root("linked");
        let main = root.join("main");
        let linked = root.join("linked");
        let repo = init_repo(&main);
        repo.worktree("linked", &linked, None).unwrap();

        let main_context = discover_workspace(main.to_str().unwrap()).unwrap();
        let linked_context = discover_workspace(linked.to_str().unwrap()).unwrap();
        assert_eq!(main_context.repository.id, linked_context.repository.id);
        assert_eq!(main_context.worktrees.len(), 2);
        assert_eq!(linked_context.worktrees.len(), 2);
        let canonical_linked = linked.canonicalize().unwrap();
        assert!(linked_context
            .worktrees
            .iter()
            .any(|w| w.current && w.path == canonical_linked.to_string_lossy()));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cwd_keeps_canonical_workspace_identity() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink");
        let main = root.join("main");
        let alias = root.join("alias");
        init_repo(&main);
        symlink(&main, &alias).unwrap();
        let direct = discover_workspace(main.to_str().unwrap()).unwrap();
        let linked = discover_workspace(alias.to_str().unwrap()).unwrap();
        assert_eq!(direct.repository.id, linked.repository.id);
        assert_eq!(direct.current_worktree_id, linked.current_worktree_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bare_repository_is_reported_without_a_current_worktree() {
        let root = test_root("bare");
        let bare = root.join("repo.git");
        Repository::init_bare(&bare).unwrap();
        let context = discover_workspace(bare.to_str().unwrap()).unwrap();
        assert!(context.repository.bare);
        assert!(context.current_worktree_id.is_none());
        assert!(context.worktrees.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detached_head_is_not_mislabelled_as_a_branch() {
        let root = test_root("detached");
        let main = root.join("main");
        let repo = init_repo(&main);
        let oid = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(oid).unwrap();
        let context = discover_workspace(main.to_str().unwrap()).unwrap();
        let current = context.worktrees.iter().find(|w| w.current).unwrap();
        let oid_string = oid.to_string();
        assert!(current.detached);
        assert!(current.branch.is_none());
        assert_eq!(current.head.as_deref(), Some(oid_string.as_str()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_linked_worktree_is_visible_but_unavailable() {
        let root = test_root("stale");
        let main = root.join("main");
        let linked = root.join("linked");
        let repo = init_repo(&main);
        repo.worktree("linked", &linked, None).unwrap();
        fs::remove_dir_all(&linked).unwrap();
        let context = discover_workspace(main.to_str().unwrap()).unwrap();
        let stale = context
            .worktrees
            .iter()
            .find(|w| w.name == "linked")
            .unwrap();
        assert!(!stale.available);
        assert!(stale.error.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
