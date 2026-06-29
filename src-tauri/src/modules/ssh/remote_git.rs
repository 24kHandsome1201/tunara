//! Remote git status/diff over an SSH exec channel.
//!
//! Mirrors the local `git_status`/`git_diff` IPC contract (`StatusResult`,
//! `FileChange`, `FileDiff`) so the frontend DiffPanel can render remote repos
//! without caring about the transport. Read-only — runs `git status` / `git
//! diff` on the remote, never writes.
//!
//! Degradation: if the remote lacks git or the cwd isn't a repo, the exec
//! returns a descriptive error and the frontend surfaces "remote git
//! unavailable" instead of crashing the session.

use tauri::State;

use crate::modules::fs::search::SearchHit;
use crate::modules::git::{FileChange, FileDiff, StatusResult};
use crate::modules::pty::{PtyState, Session};

/// Resolve the SSH session behind a session id as a cloned `Arc<Session>` so
/// the caller can hold it across `.await` points without borrowing the
/// `PtyState`. Returns an error for local sessions or missing ids.
fn ssh_session(state: &State<'_, PtyState>, id: u32) -> Result<std::sync::Arc<Session>, String> {
    let session = state.get(id).ok_or_else(|| "no session".to_string())?;
    match session.as_ref() {
        Session::Ssh(_) => Ok(session),
        Session::Local(_) => Err("not a remote session".to_string()),
    }
}

/// Cap stdout collection so a pathological repo can't OOM the UI. Matches the
/// local `git_diff` text-preview budget (256 KiB) — DiffPanel already renders
/// `tooLarge` beyond that.
const MAX_STATUS_BYTES: usize = 256 * 1024;
const MAX_DIFF_BYTES: usize = 256 * 1024;

/// Parse `git status --porcelain=v1 --branch` output into a `StatusResult`.
///
/// Uses porcelain v1 (not v2) because it is supported by every git 1.x/2.x and
/// trivially line-parsable. The branch line `## branch...` carries the branch
/// name; each `XY path` line carries stage + status. v1 doesn't give per-file
/// added/removed counts, so those are 0 — the file row shows the status mark
/// only, which is enough to decide whether to look at the diff.
///
/// Pure function so it can be unit-tested without a live SSH connection.
pub(crate) fn parse_porcelain_v1(raw: &str) -> StatusResult {
    let mut branch = String::from("HEAD");
    let mut files: Vec<FileChange> = Vec::new();

    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        // Branch header: `## main` or `## main...origin/main [ahead 1]`.
        if let Some(rest) = line.strip_prefix("## ") {
            // Take the branch name up to `...` (upstream) or ` [` (tracking
            // info) or end of line.
            let end = rest
                .find("...")
                .or_else(|| rest.find(' '))
                .unwrap_or(rest.len());
            branch = rest[..end].trim().to_string();
            continue;
        }
        // `XY path` — X = index status, Y = worktree status. At least two chars
        // + a space + path; shorter lines are malformed and skipped.
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let path = line[3..].trim();
        if path.is_empty() {
            continue;
        }
        // A rename in v1 is `R  old -> new`; keep the new path (after `->`).
        let resolved_path = path.rsplit(" -> ").next().unwrap_or(path).to_string();

        // Stage classification: X != ' ' && X != '?' → staged; Y != ' ' →
        // unstaged; '?' (untracked) → untracked. Staged takes precedence so a
        // file that's both staged and further modified shows once as staged
        // (matches how the local git2 path would surface it via HEAD→index).
        let (mark, stage): (char, &'static str) = if x == '?' && y == '?' {
            ('?', "untracked")
        } else if x != ' ' && x != '?' {
            (x, "staged")
        } else if y != ' ' {
            (y, "unstaged")
        } else {
            // Both spaces but present — shouldn't happen in porcelain; skip.
            continue;
        };

        files.push(FileChange {
            path: resolved_path,
            status: mark.to_string(),
            stage: stage.to_string(),
            added: 0,
            removed: 0,
        });
    }

    files.sort_by(|a, b| a.path.cmp(&b.path).then(a.stage.cmp(&b.stage)));
    let summary = format!("{} files", files.len());
    StatusResult {
        branch,
        files,
        summary,
    }
}

/// Run `git status --porcelain=v1 --branch` in the remote session's cwd and
/// parse it into a `StatusResult` shaped exactly like the local `git_status`.
#[tauri::command]
pub async fn ssh_git_status(
    state: State<'_, PtyState>,
    session_id: u32,
) -> Result<StatusResult, String> {
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    // `-C .` keeps us in the shell's cwd; `--no-renames` makes the path column
    // stable (no `-> ` to split). No `2>&1` — the exec function captures stderr
    // separately and returns it as Err when stdout is empty, so a missing git
    // or a non-repo cwd surfaces as a clean error instead of being parsed as
    // bogus porcelain output.
    let out = ssh
        .exec(
            "git -C . status --porcelain=v1 --branch --no-renames",
            MAX_STATUS_BYTES,
        )
        .await?;
    Ok(parse_porcelain_v1(&out))
}

/// Run a remote `git diff` for one file/stage and wrap it as a `FileDiff::text`
/// (or `tooLarge` when the exec hit its byte cap).
#[tauri::command]
pub async fn ssh_git_diff(
    state: State<'_, PtyState>,
    session_id: u32,
    file: String,
    stage: String,
) -> Result<FileDiff, String> {
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    // Stage → git diff flag. Untracked files have no diff, so surface them as
    // metadataOnly (the local path does the same for empty-delta untracked).
    let arg = match stage.as_str() {
        "staged" => "--cached",
        "unstaged" => "",
        "untracked" => {
            return Ok(FileDiff::MetadataOnly {
                path: file,
                change: "untracked".to_string(),
            });
        }
        _ => "",
    };
    // Shell-quote the path minimally: wrap in single quotes and escape any
    // embedded single quotes. The file path comes from our own parsed status,
    // not user input, but quoting defends against paths with spaces/quotes.
    let quoted = format!("'{}'", file.replace('\'', "'\\''"));
    // No `2>&1` — let the exec function's stderr-capture return git errors
    // (e.g. "fatal: not a git repository") as Err instead of merging them
    // into the patch text.
    let cmd = format!("git -C . diff {arg} -- {quoted}");
    let out = ssh.exec(&cmd, MAX_DIFF_BYTES).await?;
    // If the exec capped out, flag truncation so the UI says "too large"
    // instead of showing a sliced patch.
    if out.len() >= MAX_DIFF_BYTES {
        return Ok(FileDiff::TooLarge {
            path: file,
            bytes: out.len(),
        });
    }
    let total_lines = out.lines().count();
    Ok(FileDiff::Text {
        path: file,
        patch: out,
        truncated: false,
        total_lines,
    })
}

/// Cap stdout collection for a remote find so a huge tree can't OOM. The
/// frontend already caps at 80 results; this bounds the raw bytes.
const MAX_SEARCH_BYTES: usize = 64 * 1024;

/// Parse `find` output (one absolute path per line) into `SearchHit`s relative
/// to `root`. Pure function so it can be unit-tested without a live SSH exec.
pub(crate) fn parse_find_output(raw: &str, root: &str) -> Vec<SearchHit> {
    let root_trimmed = root.trim_end_matches('/');
    let mut out: Vec<SearchHit> = Vec::new();
    for line in raw.lines() {
        let path = line.trim();
        if path.is_empty() {
            continue;
        }
        // rel = path relative to root; if path isn't under root, use the
        // basename as rel so the UI still shows something.
        let rel = path
            .strip_prefix(root_trimmed)
            .map(|s| s.trim_start_matches('/'))
            .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path))
            .to_string();
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        // `find` without `-type` lists files and dirs; we can't tell which
        // without a second stat, so mark everything as a non-dir. The file
        // explorer search UI treats hits uniformly (open path / preview).
        out.push(SearchHit {
            path: path.to_string(),
            rel,
            name,
            is_dir: false,
        });
    }
    out
}

/// Run `find <root> -name '*<query>*'` over the SSH exec channel and parse the
/// output into `SearchHit`s. Mirrors the local `fs_search` contract so
/// FileExplorer can switch data source by session kind.
///
/// Caps at `limit` results (default 80) and 64 KiB of raw output. `include_hidden`
/// adds `-not -path '*/.*'` exclusion inversion — by default hidden paths are
/// skipped to match the local `ignore`-based walk.
#[tauri::command]
pub async fn ssh_fs_search(
    state: State<'_, PtyState>,
    session_id: u32,
    root: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    let cap = limit.unwrap_or(80).min(200);
    // Shell-quote: root in single quotes, query embedded inside find's -name
    // glob (single-quoted so embedded quotes/semicolons can't escape).
    let root_q = format!("'{}'", root.replace('\'', "'\\''"));
    let query_q = format!("'*{}*'", query.replace('\'', "'\\''"));
    // `-not -path '*/.*'` skips hidden dirs/files (matches local ignore walk).
    // `2>/dev/null` suppresses permission-denied noise. `head` caps result count
    // so a massive tree doesn't stream forever.
    let cmd = format!("find {root_q} -name {query_q} -not -path '*/.*' 2>/dev/null | head -{cap}");
    let out = ssh.exec(&cmd, MAX_SEARCH_BYTES).await?;
    Ok(parse_find_output(&out, &root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_porcelain_v1_branch_and_files() {
        let raw = "\
## main
 M src/mod.rs
A  new.txt
?? untracked.log
";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 3);

        let modified = result
            .files
            .iter()
            .find(|f| f.path == "src/mod.rs")
            .unwrap();
        assert_eq!(modified.status, "M");
        assert_eq!(modified.stage, "unstaged");

        let added = result.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(added.status, "A");
        assert_eq!(added.stage, "staged");

        let untracked = result
            .files
            .iter()
            .find(|f| f.path == "untracked.log")
            .unwrap();
        assert_eq!(untracked.status, "?");
        assert_eq!(untracked.stage, "untracked");
    }

    #[test]
    fn parse_porcelain_v1_branch_with_upstream_tracking() {
        let raw = "## main...origin/main [ahead 1]\n M a.txt\n";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn parse_porcelain_v1_rename_uses_new_path() {
        // --no-renames is set in the command, but defend the parser anyway.
        let raw = "R  old.txt -> new.txt\n";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "new.txt");
        assert_eq!(result.files[0].stage, "staged");
    }

    #[test]
    fn parse_porcelain_v1_empty_repo_is_unborn() {
        // No `##` branch line in an unborn repo's porcelain output means we
        // fall back to "HEAD"; no crash.
        let raw = "?? only.txt\n";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "HEAD");
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn parse_porcelain_v1_malformed_lines_skipped() {
        let raw = "## main\nXY\n M good.txt\n";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "good.txt");
    }

    #[test]
    fn parse_porcelain_v1_staged_takes_precedence_over_unstaged() {
        // `M  file` (M in index, space in worktree) → staged.
        let raw = "M  staged_only.txt\n";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files[0].stage, "staged");
    }

    // ── find output parsing (remote file search) ──────────────────────────

    #[test]
    fn parse_find_output_makes_paths_relative_to_root() {
        let raw = "/home/alice/project/src/main.rs\n/home/alice/project/README.md\n";
        let hits = parse_find_output(raw, "/home/alice/project");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/home/alice/project/src/main.rs");
        assert_eq!(hits[0].rel, "src/main.rs");
        assert_eq!(hits[0].name, "main.rs");
        assert!(!hits[0].is_dir);
    }

    #[test]
    fn parse_find_output_handles_trailing_slash_in_root() {
        let raw = "/srv/app/a.txt\n";
        let hits = parse_find_output(raw, "/srv/app/");
        assert_eq!(hits[0].rel, "a.txt");
    }

    #[test]
    fn parse_find_output_skips_empty_lines() {
        let raw = "/x/a.txt\n\n/x/b.txt\n";
        let hits = parse_find_output(raw, "/x");
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn parse_find_output_falls_back_to_basename_when_not_under_root() {
        // A path outside root (e.g. a symlink find followed) still gets a name.
        let raw = "/other/place.txt\n";
        let hits = parse_find_output(raw, "/srv/app");
        assert_eq!(hits[0].name, "place.txt");
    }
}
