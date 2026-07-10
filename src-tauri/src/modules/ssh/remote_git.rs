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

use crate::modules::fs::grep::{GrepHit, GrepResponse};
use crate::modules::fs::search::SearchHit;
use crate::modules::git::{FileChange, FileDiff, RemoteState, StatusResult};
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
/// Line cap mirroring the local path's `DIFF_MAX_LINES` (git/mod.rs), so the
/// DiffPanel shows the same "truncated" hint for local and remote diffs.
const MAX_DIFF_LINES: usize = 2000;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn remote_git_cwd(cwd: &str) -> Result<String, String> {
    if !cwd.starts_with('/') || cwd.len() > 4_096 || cwd.chars().any(char::is_control) {
        return Err("remote git cwd must be an absolute path".to_string());
    }
    Ok(shell_quote(cwd))
}

/// Parse NUL-delimited `git status --porcelain=v1 --branch -z` output into a
/// `StatusResult`.
///
/// Uses porcelain v1 (not v2) because it is supported by every git 1.x/2.x and
/// byte-stable. `-z` is essential: it disables Git's C-quoting and makes paths
/// containing Unicode, quotes, and newlines unambiguous. The branch record
/// `## branch...` carries the branch name; each `XY path` record carries stage
/// + status. v1 doesn't give per-file added/removed counts, so those are 0.
///
/// Pure function so it can be unit-tested without a live SSH connection.
pub(crate) fn parse_porcelain_v1(raw: &str) -> StatusResult {
    let mut branch = String::from("HEAD");
    let mut files: Vec<FileChange> = Vec::new();

    for record in raw.split('\0') {
        if record.is_empty() {
            continue;
        }
        // Branch header: `## main` or `## main...origin/main [ahead 1]`.
        if let Some(rest) = record.strip_prefix("## ") {
            if let Some(unborn) = rest.strip_prefix("No commits yet on ") {
                branch = unborn.to_string();
                continue;
            }
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
        if record.len() < 4 {
            continue;
        }
        let x = record.as_bytes()[0] as char;
        let y = record.as_bytes()[1] as char;
        let path = &record[3..];
        if path.is_empty() {
            continue;
        }
        if x == '?' && y == '?' {
            files.push(file_change(path, '?', "untracked"));
            continue;
        }
        if x == '!' && y == '!' {
            continue;
        }
        // A file can have both an index delta and a further worktree delta
        // (`MM`). Emit both rows so staged review never hides unstaged work.
        if x != ' ' && x != '?' {
            files.push(file_change(path, x, "staged"));
        }
        if y != ' ' && y != '?' {
            files.push(file_change(path, y, "unstaged"));
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path).then(a.stage.cmp(&b.stage)));
    StatusResult { branch, files }
}

fn file_change(path: &str, status: char, stage: &str) -> FileChange {
    FileChange {
        path: path.to_string(),
        status: status.to_string(),
        stage: stage.to_string(),
        added: 0,
        removed: 0,
    }
}

/// Run `git status --porcelain=v1 --branch -z` in the remote session's cwd and
/// parse it into a `StatusResult` shaped exactly like the local `git_status`.
#[tauri::command]
pub async fn ssh_git_status(
    state: State<'_, PtyState>,
    session_id: u32,
    cwd: String,
) -> Result<StatusResult, String> {
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    let cwd = remote_git_cwd(&cwd)?;
    // Exec channels start in sshd's default directory, not the interactive
    // shell's live cwd, so pass the OSC-7-tracked path explicitly.
    // `--no-renames` makes the path column
    // stable (no `-> ` to split). No `2>&1` — the exec function captures stderr
    // separately and returns it as Err when stdout is empty, so a missing git
    // or a non-repo cwd surfaces as a clean error instead of being parsed as
    // bogus porcelain output.
    let command = format!("git -C {cwd} status --porcelain=v1 --branch --no-renames -z");
    let out = ssh.exec(&command, MAX_STATUS_BYTES + 1).await?;
    if out.len() > MAX_STATUS_BYTES {
        return Err(format!(
            "remote git status exceeds {MAX_STATUS_BYTES} bytes"
        ));
    }
    Ok(parse_porcelain_v1(&out))
}

/// Run a remote `git diff` for one file/stage and wrap it as a `FileDiff::text`
/// (or `tooLarge` when the exec hit its byte cap).
#[tauri::command]
pub async fn ssh_git_diff(
    state: State<'_, PtyState>,
    session_id: u32,
    cwd: String,
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
    let quoted = shell_quote(&file);
    let cwd = remote_git_cwd(&cwd)?;
    // No `2>&1` — let the exec function's stderr-capture return git errors
    // (e.g. "fatal: not a git repository") as Err instead of merging them
    // into the patch text.
    let cmd = format!("git -C {cwd} diff {arg} -- {quoted}");
    // Ask exec for one byte over the cap: exec truncates to its limit, so a
    // result strictly longer than MAX_DIFF_BYTES is the only unambiguous
    // overflow signal (a diff of exactly the cap is complete, not too large).
    let out = ssh.exec(&cmd, MAX_DIFF_BYTES + 1).await?;
    if out.len() > MAX_DIFF_BYTES {
        return Ok(FileDiff::TooLarge {
            path: file,
            bytes: out.len(),
        });
    }
    // Under the byte cap but over the line cap: cut and flag truncation the
    // same way the local path does, instead of silently returning a patch the
    // local DiffPanel would have labelled as truncated.
    let total_lines = out.lines().count();
    if total_lines > MAX_DIFF_LINES {
        let patch = out
            .lines()
            .take(MAX_DIFF_LINES)
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(FileDiff::Text {
            path: file,
            patch,
            truncated: true,
            total_lines,
        });
    }
    Ok(FileDiff::Text {
        path: file,
        patch: out,
        truncated: false,
        total_lines,
    })
}

/// Run `git rev-list --left-right --count @{u}...HEAD` over the SSH exec
/// channel and parse it into a `RemoteState`, mirroring the local
/// `git_ahead_behind` IPC contract so DiffPanel can render the ahead/behind
/// indicator for remote repos.
///
/// Uses `@{u}` (upstream shorthand) so the remote shell resolves the tracked
/// upstream without us guessing its name. Degrades to `NoUpstream` when the
/// branch has no upstream, `Detached` when HEAD is detached, and `Unknown` for
/// any other git failure (missing git, not a repo, malformed output).
#[tauri::command]
pub async fn ssh_git_ahead_behind(
    state: State<'_, PtyState>,
    session_id: u32,
    cwd: String,
) -> Result<RemoteState, String> {
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    let cwd = remote_git_cwd(&cwd)?;
    // `rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>"
    // (one line, tab-separated).
    let rev_list = format!("git -C {cwd} rev-list --left-right --count @{{u}}...HEAD 2>/dev/null");
    let out = ssh.exec_allow_nonzero(&rev_list, 256).await?;
    let trimmed = out.trim();
    // Empty output: no upstream (git exited non-zero, stderr suppressed).
    if trimmed.is_empty() {
        // Fall back to reading the branch name so the UI can show it.
        let branch_command = format!("git -C {cwd} symbolic-ref --short HEAD 2>/dev/null");
        let branch_out = ssh.exec(&branch_command, 128).await.unwrap_or_default();
        let branch = branch_out.trim().to_string();
        if branch.is_empty() {
            // No HEAD ref at all → detached or unborn. Distinguish via
            // rev-parse HEAD: success means detached.
            let head_command = format!("git -C {cwd} rev-parse --short HEAD 2>/dev/null");
            let head_out = ssh.exec(&head_command, 128).await.unwrap_or_default();
            let oid = head_out.trim().to_string();
            if oid.is_empty() {
                return Ok(RemoteState::Unborn);
            }
            return Ok(RemoteState::Detached { oid });
        }
        return Ok(RemoteState::NoUpstream { branch });
    }
    // Parse "<behind>\t<ahead>". Malformed → Unknown.
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() != 2 {
        return Ok(RemoteState::Unknown {
            message: format!("unexpected rev-list output: {trimmed}"),
        });
    }
    let Ok(behind) = parts[0].parse::<usize>() else {
        return Ok(RemoteState::Unknown {
            message: format!("non-numeric behind count: {}", parts[0]),
        });
    };
    let Ok(ahead) = parts[1].parse::<usize>() else {
        return Ok(RemoteState::Unknown {
            message: format!("non-numeric ahead count: {}", parts[1]),
        });
    };
    // Resolve the upstream name for the UI label.
    let upstream_command = format!("git -C {cwd} rev-parse --abbrev-ref @{{u}} 2>/dev/null");
    let up_out = ssh.exec(&upstream_command, 128).await.unwrap_or_default();
    let upstream = up_out.trim().to_string();
    Ok(RemoteState::Ok {
        upstream,
        ahead,
        behind,
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

// ── Remote content search (grep over the exec channel) ─────────────────────

/// Byte cap on remote grep stdout, matching the remote status budget. The line
/// cap below is the primary limiter; this bounds pathological single lines.
const MAX_GREP_BYTES: usize = 256 * 1024;
/// Response cap defaults/limits, mirroring the local `fs_grep` contract.
const REMOTE_GREP_DEFAULT_RESULTS: usize = 200;
const REMOTE_GREP_HARD_MAX_RESULTS: usize = 1000;

/// Parse `grep -rn` output (`./rel/path:LINE:text` per line, produced by
/// grepping `.` after `cd`-ing into `root`) into `GrepHit`s plus a truncation
/// flag. Pure function so it can be unit-tested without a live SSH exec.
///
/// Defensive parsing rules:
/// - a line must split as `path:number:text`; anything else (banner noise,
///   a path whose name itself contains `:` before the line number) is skipped
///   rather than guessed at;
/// - hidden paths (any `.`-prefixed component) are filtered here instead of
///   with fragile `--exclude-dir='.*'` globs, whose treatment of the `.` start
///   directory differs between GNU and BSD grep;
/// - if the raw output was byte-capped mid-line (no trailing newline), the
///   final partial hit is dropped and the result is marked truncated.
pub(crate) fn parse_grep_output(raw: &str, root: &str, max_results: usize) -> (Vec<GrepHit>, bool) {
    let root_trimmed = root.trim_end_matches('/');
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut truncated = false;

    for line in raw.lines() {
        if hits.len() > max_results {
            // The command asks head for max_results + 1 lines precisely so an
            // extra parsed hit here proves more matches exist.
            truncated = true;
            break;
        }
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, ':');
        let (Some(path_part), Some(line_part), Some(text)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(line_no) = line_part.parse::<u64>() else {
            continue;
        };
        let rel = path_part
            .strip_prefix("./")
            .unwrap_or(path_part)
            .trim_start_matches('/');
        if rel.is_empty() {
            continue;
        }
        // Hidden filter: matches the local walker's hidden(true) behavior.
        if rel.split('/').any(|component| component.starts_with('.')) {
            continue;
        }
        hits.push(GrepHit {
            path: format!("{root_trimmed}/{rel}"),
            rel: rel.to_string(),
            line: line_no,
            text: text.trim_end_matches('\r').to_string(),
        });
    }

    // Byte-cap cut mid-line: the last "hit" may be a sliced fragment.
    if !raw.is_empty() && !raw.ends_with('\n') && !hits.is_empty() {
        hits.pop();
        truncated = true;
    }
    if hits.len() > max_results {
        hits.truncate(max_results);
        truncated = true;
    }
    (hits, truncated)
}

/// Run a content search (`grep -rEIn`) in `root` over the SSH exec channel and
/// return it in the exact shape of the local `fs_grep`, so FileExplorer's
/// content-search mode works for SSH sessions too.
///
/// Requires a POSIX-ish remote shell and a grep supporting `-r -E -I -n` and
/// `--exclude-dir` (GNU and BSD both qualify). grep's stderr is suppressed so
/// permission noise can't fail a valid search, which means a minimal busybox
/// grep degrades to an empty result — the same silent posture the remote
/// shell-integration takes on unsupported hosts. The `--exclude-dir` list
/// mirrors the local watcher's noisy-path set; hidden paths are filtered in
/// the parser (see `parse_grep_output`).
///
/// `files_scanned` cannot be known remotely; it reports the number of distinct
/// files among the hits instead (the UI only renders hits + truncated).
#[tauri::command]
pub async fn ssh_fs_grep(
    state: State<'_, PtyState>,
    session_id: u32,
    root: String,
    pattern: String,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<GrepResponse, String> {
    if pattern.is_empty() {
        return Err("empty pattern".into());
    }
    let session = ssh_session(&state, session_id)?;
    let ssh = match session.as_ref() {
        Session::Ssh(s) => s,
        Session::Local(_) => return Err("not a remote session".to_string()),
    };
    let cap = max_results
        .unwrap_or(REMOTE_GREP_DEFAULT_RESULTS)
        .clamp(1, REMOTE_GREP_HARD_MAX_RESULTS);

    // Shell-quote root and pattern (same single-quote escape the diff path
    // uses); `-e` keeps a leading `-` in the pattern from becoming a flag.
    let root_q = format!("'{}'", root.replace('\'', "'\\''"));
    let pattern_q = format!("'{}'", pattern.replace('\'', "'\\''"));
    let case_flag = if case_insensitive == Some(true) {
        "-i "
    } else {
        ""
    };
    // head asks for cap + 1 lines so the parser can distinguish "exactly cap
    // matches" from "more matches exist". grep's stderr is discarded so
    // permission-denied noise on a single unreadable subdir can't turn a valid
    // zero-match search into an error; cd's stderr is NOT discarded, so a
    // missing/denied root still surfaces as a visible failure via exec's
    // empty-stdout-with-stderr path.
    let head_cap = cap + 1;
    let cmd = format!(
        "cd {root_q} && grep -rEIn {case_flag}--exclude-dir=.git --exclude-dir=node_modules \
         --exclude-dir=target --exclude-dir=dist -e {pattern_q} . 2>/dev/null | head -n {head_cap}"
    );
    let out = ssh.exec(&cmd, MAX_GREP_BYTES).await?;
    let (hits, truncated) = parse_grep_output(&out, &root, cap);
    let files_scanned = {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for hit in &hits {
            seen.insert(hit.rel.as_str());
        }
        seen.len()
    };
    Ok(GrepResponse {
        hits,
        truncated,
        files_scanned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_git_cwd_is_absolute_and_shell_quoted() {
        assert_eq!(
            remote_git_cwd("/srv/repo with 'quote'").unwrap(),
            "'/srv/repo with '\\''quote'\\'''"
        );
        assert!(remote_git_cwd("relative/repo").is_err());
        assert!(remote_git_cwd("/srv/repo\nnext").is_err());
    }

    #[test]
    fn parse_porcelain_v1_branch_and_files() {
        let raw = "\
## main\0 M src/mod.rs\0A  new.txt\0?? untracked.log\0
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
        let raw = "## main...origin/main [ahead 1]\0 M a.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn parse_porcelain_v1_rename_status_is_staged() {
        // --no-renames makes Git report the destination as an ordinary path.
        let raw = "R  new.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "new.txt");
        assert_eq!(result.files[0].stage, "staged");
    }

    #[test]
    fn parse_porcelain_v1_empty_repo_is_unborn() {
        // No `##` branch line in an unborn repo's porcelain output means we
        // fall back to "HEAD"; no crash.
        let raw = "## No commits yet on main\0?? only.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.branch, "main");
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn parse_porcelain_v1_malformed_lines_skipped() {
        let raw = "## main\0XY\0 M good.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path, "good.txt");
    }

    #[test]
    fn parse_porcelain_v1_preserves_unicode_newlines_and_both_stages() {
        let raw = "MM 中文\nfile.txt\0";
        let result = parse_porcelain_v1(raw);
        assert_eq!(result.files.len(), 2);
        assert!(result
            .files
            .iter()
            .all(|file| file.path == "中文\nfile.txt"));
        assert_eq!(result.files[0].stage, "staged");
        assert_eq!(result.files[1].stage, "unstaged");
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

    // ── grep output parsing (remote content search) ────────────────────────

    #[test]
    fn parse_grep_output_builds_hits_relative_to_root() {
        let raw = "./src/main.rs:12:fn main() {\n./README.md:3:usage: tunara\n";
        let (hits, truncated) = parse_grep_output(raw, "/home/alice/project", 200);
        assert!(!truncated);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/home/alice/project/src/main.rs");
        assert_eq!(hits[0].rel, "src/main.rs");
        assert_eq!(hits[0].line, 12);
        assert_eq!(hits[0].text, "fn main() {");
    }

    #[test]
    fn parse_grep_output_keeps_colons_inside_the_matched_text() {
        // Only the first two `:` separate path and line; the rest is text.
        let raw = "./a.ts:5:const url = \"http://x:8080\";\n";
        let (hits, _) = parse_grep_output(raw, "/r", 200);
        assert_eq!(hits[0].text, "const url = \"http://x:8080\";");
    }

    #[test]
    fn parse_grep_output_skips_malformed_and_hidden_lines() {
        let raw = "\
banner noise without separators
./.hidden/secret.txt:1:match in hidden dir
./src/ok.rs:notanumber:bad line field
./src/ok.rs:7:real match
";
        let (hits, truncated) = parse_grep_output(raw, "/r", 200);
        assert!(!truncated);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel, "src/ok.rs");
        assert_eq!(hits[0].line, 7);
    }

    #[test]
    fn parse_grep_output_truncates_at_max_results() {
        // head hands back cap + 1 lines; the extra line proves more exist.
        let raw = "./a:1:x\n./b:2:y\n./c:3:z\n";
        let (hits, truncated) = parse_grep_output(raw, "/r", 2);
        assert!(truncated);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn parse_grep_output_drops_a_byte_capped_partial_final_line() {
        // Output cut mid-line by the exec byte cap must not surface a sliced
        // fragment as a hit.
        let raw = "./a.txt:1:whole line\n./b.txt:2:slice";
        let (hits, truncated) = parse_grep_output(raw, "/r", 200);
        assert!(truncated);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel, "a.txt");
    }

    #[test]
    fn parse_grep_output_handles_root_with_trailing_slash_and_bare_root() {
        let raw = "./x.txt:1:hit\n";
        let (hits, _) = parse_grep_output(raw, "/srv/app/", 200);
        assert_eq!(hits[0].path, "/srv/app/x.txt");
        let (hits, _) = parse_grep_output(raw, "/", 200);
        assert_eq!(hits[0].path, "/x.txt");
    }
}
