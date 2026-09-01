//! Fast, best-effort discovery of recently active local git repos.
//!
//! Used only by the empty-state first-run cards. Failures are silent: the
//! command never returns `Err`, never blocks a real terminal, and is bounded
//! by depth, directory count, result count, and a wall-clock deadline.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::expand_tilde;

const DEFAULT_ROOTS: &[&str] = &[
    "~/dev",
    "~/code",
    "~/projects",
    "~/workspace",
    "~/src",
    "~/Developer",
    "~/work",
    "~/git",
    "~/repos",
];

const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "Library",
    "Applications",
    ".cache",
    ".local",
    ".Trash",
];

pub const DEFAULT_MAX_DEPTH: u32 = 2;
pub const DEFAULT_MAX_RESULTS: usize = 8;
pub const DEFAULT_MAX_DIRS: usize = 240;
pub const DEFAULT_DEADLINE: Duration = Duration::from_millis(180);

#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_depth: u32,
    pub max_results: usize,
    pub max_dirs: usize,
    pub deadline: Duration,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_results: DEFAULT_MAX_RESULTS,
            max_dirs: DEFAULT_MAX_DIRS,
            deadline: DEFAULT_DEADLINE,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentGitRepo {
    pub path: String,
    pub name: String,
    pub mtime: u64,
}

/// Empty-state command. Always succeeds with a (possibly empty) list.
#[tauri::command]
pub fn fs_scan_recent_repos() -> Vec<RecentGitRepo> {
    let roots: Vec<PathBuf> = DEFAULT_ROOTS
        .iter()
        .map(|root| expand_tilde(root))
        .collect();
    scan_recent_git_repos_with(&roots, ScanLimits::default())
}

pub fn scan_recent_git_repos_with(roots: &[PathBuf], limits: ScanLimits) -> Vec<RecentGitRepo> {
    let started = Instant::now();
    let mut found: Vec<RecentGitRepo> = Vec::new();
    let mut seen = HashSet::new();
    let mut dirs_visited = 0usize;

    for root in roots {
        if started.elapsed() >= limits.deadline {
            break;
        }
        if dirs_visited >= limits.max_dirs {
            break;
        }
        let Ok(meta) = fs::symlink_metadata(root) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        walk_root(
            root,
            0,
            limits,
            started,
            &mut dirs_visited,
            &mut seen,
            &mut found,
        );
    }

    found.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.path.cmp(&b.path)));
    found.truncate(limits.max_results);
    found
}

fn walk_root(
    dir: &Path,
    depth: u32,
    limits: ScanLimits,
    started: Instant,
    dirs_visited: &mut usize,
    seen: &mut HashSet<String>,
    found: &mut Vec<RecentGitRepo>,
) {
    if started.elapsed() >= limits.deadline || *dirs_visited >= limits.max_dirs {
        return;
    }
    *dirs_visited += 1;

    if is_git_repo(dir) {
        record_repo(dir, seen, found);
        // Nested repos under an already-recorded checkout are rarely useful
        // for first-run cards; still look at immediate children when depth 0
        // so a workspace folder of many repos is discovered.
        if depth >= 1 {
            return;
        }
    }

    if depth >= limits.max_depth {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries {
        if started.elapsed() >= limits.deadline || *dirs_visited >= limits.max_dirs {
            return;
        }
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') || should_skip_dir_name(name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_dir() {
            continue;
        }
        walk_root(&path, depth + 1, limits, started, dirs_visited, seen, found);
    }
}

fn should_skip_dir_name(name: &str) -> bool {
    SKIP_DIR_NAMES.iter().any(|skip| *skip == name)
}

fn is_git_repo(path: &Path) -> bool {
    let git = path.join(".git");
    match fs::symlink_metadata(&git) {
        Ok(meta) => meta.is_dir() || meta.file_type().is_file(),
        Err(_) => false,
    }
}

fn record_repo(path: &Path, seen: &mut HashSet<String>, found: &mut Vec<RecentGitRepo>) {
    let display = path.to_string_lossy().into_owned();
    if display.is_empty() || !seen.insert(display.clone()) {
        return;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("repository")
        .to_string();
    found.push(RecentGitRepo {
        path: display,
        name,
        mtime: mtime_millis(path),
    });
}

fn mtime_millis(path: &Path) -> u64 {
    let from_path = fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    let from_git = fs::metadata(path.join(".git"))
        .ok()
        .and_then(|meta| meta.modified().ok());
    let stamp = match (from_path, from_git) {
        (Some(a), Some(b)) => a.max(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return 0,
    };
    stamp
        .duration_since(SystemTime::UNIX_EPOCH.min(stamp))
        .unwrap_or_else(|_| UNIX_EPOCH.elapsed().unwrap_or_default())
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::{scan_recent_git_repos_with, ScanLimits};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "tunara-recent-repos-{}-{}",
                std::process::id(),
                suffix
            ));
            fs::create_dir_all(&path).expect("create fixture root");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn init_git(path: &Path) {
        fs::create_dir_all(path.join(".git")).expect("create .git");
    }

    fn touch_later(path: &Path) {
        std::thread::sleep(Duration::from_millis(20));
        fs::write(path.join(".tunara-mtime"), b"later").expect("touch later");
    }

    fn limits() -> ScanLimits {
        ScanLimits {
            max_depth: 2,
            max_results: 8,
            max_dirs: 240,
            deadline: Duration::from_secs(2),
        }
    }

    #[test]
    fn missing_roots_are_skipped_silently() {
        let dir = TestDir::new();
        let missing = dir.path.join("does-not-exist");
        let found = scan_recent_git_repos_with(&[missing], limits());
        assert!(found.is_empty());
    }

    #[test]
    fn finds_git_repos_under_common_roots_and_sorts_newest_first() {
        let dir = TestDir::new();
        let projects = dir.path.join("projects");
        let older = projects.join("older");
        let newer = projects.join("newer");
        fs::create_dir_all(&older).unwrap();
        fs::create_dir_all(&newer).unwrap();
        init_git(&older);
        init_git(&newer);
        touch_later(&newer);

        let found = scan_recent_git_repos_with(&[projects], limits());
        let paths: Vec<&str> = found.iter().map(|repo| repo.path.as_str()).collect();
        assert!(
            paths.contains(&newer.to_string_lossy().as_ref()),
            "missing newer repo in {paths:?}"
        );
        assert!(
            paths.contains(&older.to_string_lossy().as_ref()),
            "missing older repo in {paths:?}"
        );
        let newer_pos = found
            .iter()
            .position(|repo| repo.path == newer.to_string_lossy())
            .unwrap();
        let older_pos = found
            .iter()
            .position(|repo| repo.path == older.to_string_lossy())
            .unwrap();
        assert!(
            newer_pos < older_pos,
            "expected newer repo first, got {found:?}"
        );
        assert_eq!(found[newer_pos].name, "newer");
    }

    #[test]
    fn skips_nested_repos_inside_an_already_recorded_checkout() {
        let dir = TestDir::new();
        let root = dir.path.join("code");
        let outer = root.join("app");
        let nested = outer.join("vendor-lib");
        fs::create_dir_all(&nested).unwrap();
        init_git(&outer);
        init_git(&nested);

        let found = scan_recent_git_repos_with(&[root], limits());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, outer.to_string_lossy());
    }

    #[test]
    fn skips_node_modules_and_respects_result_cap() {
        let dir = TestDir::new();
        let root = dir.path.join("dev");
        fs::create_dir_all(root.join("node_modules/secret")).unwrap();
        init_git(&root.join("node_modules/secret"));
        for index in 0..6 {
            let repo = root.join(format!("repo-{index}"));
            fs::create_dir_all(&repo).unwrap();
            init_git(&repo);
        }

        let found = scan_recent_git_repos_with(
            &[root],
            ScanLimits {
                max_results: 3,
                ..limits()
            },
        );
        assert_eq!(found.len(), 3);
        assert!(found.iter().all(|repo| !repo.path.contains("node_modules")));
    }

    #[test]
    fn accepts_gitfile_worktrees() {
        let dir = TestDir::new();
        let root = dir.path.join("worktrees");
        let repo = root.join("linked");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join(".git"), "gitdir: /tmp/somewhere.git\n").unwrap();

        let found = scan_recent_git_repos_with(&[root], limits());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "linked");
    }
}
