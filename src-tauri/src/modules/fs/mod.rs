pub mod file;
pub mod grep;
pub mod search;
pub mod tree;

use std::path::PathBuf;

pub fn expand_tilde(path: &str) -> PathBuf {
    if path.starts_with('~') {
        if let Ok(home) = std::env::var("HOME") {
            if path == "~" {
                return PathBuf::from(home);
            }
            return PathBuf::from(home).join(&path[2..]);
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
        // NOTE: the implementation slices path[2..] for the prefixed case, so
        // "~/projects" joins "projects" onto home. This pins that contract.
        assert_eq!(
            expand_tilde("~/projects"),
            PathBuf::from(&home).join("projects")
        );
    }
}
