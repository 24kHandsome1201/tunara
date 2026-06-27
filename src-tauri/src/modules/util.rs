//! 小工具：路径展开。
//!
//! 前端会话目录可能是 `~` / `~/projects/foo` 这类带波浪号的路径,但 git2
//! 的 `Repository::discover` 与 `Command::current_dir` 都不展开 `~`。统一在
//! 进入后端命令时展开,避免"目录不存在/不是仓库"的误报。

use std::path::PathBuf;

/// 将以 `~` 开头的路径展开为绝对路径（基于 `$HOME`）。其他原样返回。
pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return home_dir().unwrap_or_else(|| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return PathBuf::from(home)
                .join(rest)
                .to_string_lossy()
                .into_owned();
        }
    }
    path.to_string()
}

fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::expand_tilde;

    fn home() -> Option<String> {
        std::env::var("HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
    }

    #[test]
    fn expand_tilde_passes_through_non_tilde_paths() {
        assert_eq!(expand_tilde("/etc/hosts"), "/etc/hosts");
        assert_eq!(expand_tilde("relative/path"), "relative/path");
        assert_eq!(expand_tilde(""), "");
        // A tilde not at the start is not expanded.
        assert_eq!(expand_tilde("/a/~/b"), "/a/~/b");
    }

    #[test]
    fn expand_tilde_expands_bare_and_prefixed_tilde_against_home() {
        // Read (don't mutate) HOME to avoid racing other parallel tests.
        let Some(home) = home() else { return };
        assert_eq!(expand_tilde("~"), home);
        let expected = std::path::PathBuf::from(&home)
            .join("projects/foo")
            .to_string_lossy()
            .into_owned();
        assert_eq!(expand_tilde("~/projects/foo"), expected);
    }
}
