pub mod file;
pub mod grep;
pub mod mutate;
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
