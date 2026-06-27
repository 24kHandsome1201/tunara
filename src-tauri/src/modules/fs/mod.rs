//! Local filesystem reads for the file explorer, preview, and search.
//!
//! Read-only by design — no write/edit commands (Tunara has no built-in
//! editor). Submodules group the surface by concern:
//! - [`tree`]: directory listing — `fs_read_dir`, `list_subdirs`.
//! - [`file`]: single-file reads — `fs_read_file` (text/binary/too-large,
//!   capped preview), `fs_stat`.
//! - [`search`]: filename search — `fs_search`.
//! - [`grep`]: content search and globbing — `fs_grep`, `fs_glob`.
//!
//! [`expand_tilde`] resolves a leading `~` against `$HOME` for path inputs.
//! All commands are synchronous `#[tauri::command]` functions; the remote
//! counterparts live in [`crate::modules::ssh::sftp`] with matching shapes.
pub mod file;
pub mod grep;
pub mod search;
pub mod tree;

use std::path::PathBuf;

pub fn expand_tilde(path: &str) -> PathBuf {
    // Only `~` and `~/...` expand; `~user` and any non-leading `~` pass through.
    // Slicing `&path[2..]` (the previous approach) panics when byte index 2 lands
    // inside a multi-byte UTF-8 char (e.g. `~é`) — and with `panic = "abort"` in
    // release that takes the whole app down — and silently drops a char for the
    // slash-less `~x` form. `strip_prefix` always splits on a char boundary, so
    // it is both panic-safe and correct. Mirrors `util::expand_tilde` /
    // `ssh::auth::expand_tilde`, which already use this shape.
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::expand_tilde;
    use std::path::PathBuf;

    #[test]
    fn expand_tilde_passes_through_non_tilde_paths() {
        assert_eq!(expand_tilde("/var/log"), PathBuf::from("/var/log"));
        assert_eq!(expand_tilde("rel/dir"), PathBuf::from("rel/dir"));
    }

    #[test]
    fn expand_tilde_expands_bare_and_prefixed_tilde_against_home() {
        // Read (don't mutate) HOME to keep parallel tests independent.
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        assert_eq!(expand_tilde("~"), PathBuf::from(&home));
        // "~/projects" joins "projects" onto home.
        assert_eq!(
            expand_tilde("~/projects"),
            PathBuf::from(&home).join("projects")
        );
    }

    #[test]
    fn expand_tilde_does_not_panic_on_tricky_tilde_inputs() {
        // Regression for the old `&path[2..]` slice: `~é` has a multi-byte char
        // straddling byte 2, which used to panic (fatal under panic=abort). The
        // slash-less `~x` form must pass through literally rather than dropping a
        // char. Neither should expand, since only `~` and `~/...` are tilde forms.
        assert_eq!(expand_tilde("~é"), PathBuf::from("~é"));
        assert_eq!(expand_tilde("~x"), PathBuf::from("~x"));
    }
}
