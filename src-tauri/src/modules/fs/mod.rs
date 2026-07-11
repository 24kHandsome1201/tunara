//! Local filesystem reads plus conflict-safe single-file text writes.
//!
//! Read-only by design — no write/edit commands (Tunara has no built-in
//! editor). Submodules group the surface by concern:
//! - [`tree`]: directory listing — `fs_read_dir`.
//! - [`file`]: capped reads and fingerprint-guarded atomic text replacement.
//! - [`search`]: filename search — `fs_search`.
//! - [`grep`]: content search — `fs_grep`.
//!
//! [`expand_tilde`] resolves a leading `~` against `$HOME` for path inputs.
//! All commands are synchronous `#[tauri::command]` functions; the remote
//! counterparts live in [`crate::modules::ssh::sftp`] with matching shapes.
pub mod file;
pub mod grep;
pub mod search;
pub mod tree;

use std::path::PathBuf;

/// Expand a leading `~` against `$HOME`. Delegates to [`util::expand_tilde_path`]
/// so the tilde-expansion logic has a single source of truth shared with the
/// SSH path (which uses `dirs::home_dir()` instead of `$HOME`).
pub fn expand_tilde(path: &str) -> PathBuf {
    crate::modules::util::expand_tilde_path(path)
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
