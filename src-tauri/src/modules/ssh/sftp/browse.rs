use std::time::Duration;

use super::{remote_mtime_millis, EntryKind, RemoteDirEntry, SFTP_CONTROL_TIMEOUT};
use crate::modules::pty::{PtyState, Session};
use crate::modules::ssh::connection::await_stage;
const MAX_REMOTE_DIR_ENTRIES: usize = 10_000;

const MAX_REMOTE_DIR_NAME_BYTES: usize = 4 * 1024 * 1024;

const SFTP_DIRECTORY_TIMEOUT: Duration = Duration::from_secs(30);

fn usable_remote_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// List a remote directory. Mirrors fs_read_dir: dirs first, hidden filtered
/// unless requested, sorted by name within kind.
#[tauri::command]
pub async fn ssh_fs_read_dir(
    state: tauri::State<'_, PtyState>,
    id: u32,
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<RemoteDirEntry>, String> {
    (async {
        let include_hidden = include_hidden.unwrap_or(false);
        let session = state.get(id).ok_or_else(|| "no session".to_string())?;
        let entries = match session.as_ref() {
            Session::Ssh(ssh) => {
                ssh.read_dir_bounded(
                    &path,
                    MAX_REMOTE_DIR_ENTRIES,
                    MAX_REMOTE_DIR_NAME_BYTES,
                    SFTP_DIRECTORY_TIMEOUT,
                )
                .await?
            }
            Session::Local(_) => return Err("not a remote session".to_string()),
        };

        let mut out: Vec<RemoteDirEntry> = Vec::new();
        for entry in entries {
            let name = entry.filename;
            if !usable_remote_dir_name(&name) {
                continue;
            }
            if !include_hidden && name.starts_with('.') {
                continue;
            }
            let meta = entry.attrs;
            let kind = if meta.is_dir() {
                EntryKind::Dir
            } else if meta.is_symlink() {
                EntryKind::Symlink
            } else {
                EntryKind::File
            };
            out.push(RemoteDirEntry {
                name,
                kind,
                size: meta.size.unwrap_or(0),
                mtime: remote_mtime_millis(meta.mtime.unwrap_or(0)),
            });
        }

        // Dirs first, then case-insensitive by name. Cache the lowercased key so
        // to_lowercase() runs once per entry (n) instead of per comparison (n log n).
        out.sort_by_cached_key(|e| {
            let rank: u8 = match e.kind {
                EntryKind::Dir => 0,
                _ => 1,
            };
            (rank, e.name.to_lowercase())
        });
        Ok(out)
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpRead, error)
    })
}

/// Pick the better of an SFTP-derived path and an `echo $HOME` exec result.
///
/// `canonicalize(".")` is the cheap, no-extra-round-trip way to learn the remote
/// home, and on a normal OpenSSH server the SFTP subsystem starts in the user's
/// home so it returns e.g. `/home/you`. But some sftp-server implementations
/// (and chroot setups) start the subsystem at `/`, so `.` canonicalizes to the
/// filesystem root and the file panel gets stuck showing only root-level files.
///
/// When the SFTP answer is unusable (`/`, empty, or the SFTP call failed) we
/// fall back to the shell's `$HOME`. We only *accept* the exec answer if it is a
/// non-root absolute path — otherwise (root login whose home really is `/`, or
/// garbled output) we keep the SFTP answer. Pure so it can be unit-tested
/// without a live connection.
fn choose_remote_home(sftp_home: Option<&str>, exec_home: Option<&str>) -> Option<String> {
    let usable = |p: &str| {
        let p = p.trim();
        !p.is_empty() && p != "/" && p.starts_with('/') && !p.contains('\n')
    };
    // Prefer a usable SFTP result: it's the canonical, symlink-resolved path.
    if let Some(s) = sftp_home {
        if usable(s) {
            return Some(s.trim().to_string());
        }
    }
    // SFTP was `/`/empty/failed — try the shell's $HOME.
    if let Some(e) = exec_home {
        let e = e.trim();
        if usable(e) {
            return Some(e.to_string());
        }
    }
    // Neither is a usable non-root path. Fall back to whatever SFTP gave (likely
    // `/`), which is correct for a root login and still a usable browse root.
    sftp_home
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve the remote home directory so the panel has a sensible starting point
/// for a freshly-connected session. Tries SFTP `canonicalize(".")` first and
/// falls back to the shell's `$HOME` over an exec channel when SFTP lands at the
/// filesystem root (see `choose_remote_home`).
#[tauri::command]
pub async fn ssh_fs_home(state: tauri::State<'_, PtyState>, id: u32) -> Result<String, String> {
    (async {
        let session = state.get(id).ok_or_else(|| "no session".to_string())?;
        let ssh = match session.as_ref() {
            Session::Ssh(ssh) => ssh,
            Session::Local(_) => return Err("not a remote session".to_string()),
        };

        let sftp = ssh.sftp().await?;
        let sftp_home = await_stage(
            "resolve remote home",
            SFTP_CONTROL_TIMEOUT,
            sftp.canonicalize("."),
        )
        .await
        .ok();

        // Skip the extra exec round-trip when SFTP already gave a usable home.
        let needs_fallback = sftp_home
            .as_deref()
            .map(|h| h.trim().is_empty() || h.trim() == "/")
            .unwrap_or(true);
        let exec_home = if needs_fallback {
            // `printf` avoids the trailing-newline-plus-quirks of some shells' echo;
            // a small cap is plenty for a path. Failures collapse to None.
            ssh.exec("printf '%s' \"$HOME\"", 4096).await.ok()
        } else {
            None
        };

        choose_remote_home(sftp_home.as_deref(), exec_home.as_deref())
            .ok_or_else(|| "resolve remote home failed".to_string())
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpRead, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prefers_usable_sftp_home_without_exec() {
        // Normal server: SFTP already gives the real home, exec not even run.
        let got = choose_remote_home(Some("/home/alice"), None);
        assert_eq!(got.as_deref(), Some("/home/alice"));
    }

    #[test]
    fn falls_back_to_exec_home_when_sftp_is_root() {
        // The bug case: SFTP canonicalizes "." to "/", $HOME has the real path.
        let got = choose_remote_home(Some("/"), Some("/home/bob"));
        assert_eq!(got.as_deref(), Some("/home/bob"));
    }

    #[test]
    fn falls_back_to_exec_home_when_sftp_failed() {
        let got = choose_remote_home(None, Some("/home/carol"));
        assert_eq!(got.as_deref(), Some("/home/carol"));
    }

    #[test]
    fn trims_trailing_whitespace_from_exec_home() {
        // `printf '%s'` shouldn't add one, but a shell profile might echo extra.
        let got = choose_remote_home(Some("/"), Some("/home/dave\n"));
        assert_eq!(got.as_deref(), Some("/home/dave"));
    }

    #[test]
    fn keeps_root_for_root_login_when_exec_also_root() {
        // root's $HOME is sometimes literally "/": don't loop, just accept root.
        let got = choose_remote_home(Some("/"), Some("/"));
        assert_eq!(got.as_deref(), Some("/"));
    }

    #[test]
    fn keeps_sftp_root_when_exec_home_is_garbage() {
        // Relative / empty / multiline exec output is rejected; SFTP `/` stands.
        assert_eq!(
            choose_remote_home(Some("/"), Some("")).as_deref(),
            Some("/")
        );
        assert_eq!(
            choose_remote_home(Some("/"), Some("not-a-path")).as_deref(),
            Some("/")
        );
        assert_eq!(
            choose_remote_home(Some("/"), Some("/a\n/b")).as_deref(),
            Some("/")
        );
    }

    #[test]
    fn returns_none_when_nothing_usable() {
        assert_eq!(choose_remote_home(None, None), None);
        assert_eq!(choose_remote_home(Some(""), None), None);
    }

    #[test]
    fn remote_dir_listings_drop_empty_and_path_like_names() {
        assert!(!usable_remote_dir_name(""));
        assert!(!usable_remote_dir_name("."));
        assert!(!usable_remote_dir_name(".."));
        assert!(!usable_remote_dir_name("/"));
        assert!(!usable_remote_dir_name("bin/ls"));
        assert!(usable_remote_dir_name("bin"));
        assert!(usable_remote_dir_name("tmp"));
    }
}
