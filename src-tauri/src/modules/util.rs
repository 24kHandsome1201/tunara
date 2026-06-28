//! 小工具：路径展开。
//!
//! 前端会话目录可能是 `~` / `~/projects/foo` 这类带波浪号的路径,但 git2
//! 的 `Repository::discover` 与 `Command::current_dir` 都不展开 `~`。统一在
//! 进入后端命令时展开,避免"目录不存在/不是仓库"的误报。
//!
//! [`expand_tilde_with`] 是核心实现,接受调用方已解析的 home 目录——本地
//! 路径传 `$HOME`,SSH 路径传 `dirs::home_dir()`(macOS GUI 启动时 `$HOME`
//! 可能未设置)。[`expand_tilde`] 和 [`expand_tilde_path`] 是基于 `$HOME`
//! 的便捷封装;SSH 侧直接调用核心函数传入 `dirs::home_dir()`。

use std::path::PathBuf;

/// 核心展开逻辑:将以 `~` 开头的路径针对 `home` 展开为绝对路径,其他原样
/// 返回。`home` 由调用方提供,以便本地路径用 `$HOME`、SSH 路径用
/// `dirs::home_dir()`。使用 `strip_prefix`(字符边界安全)——旧的
/// `&path[2..]` 切片在字节 2 处遇到多字节 UTF-8 字符时会 panic,在
/// `panic = "abort"` 的 release 构建中会直接崩溃整个应用。
pub fn expand_tilde_with(path: &str, home: Option<&std::path::Path>) -> PathBuf {
    if path == "~" {
        if let Some(h) = home {
            return h.to_path_buf();
        }
    } else if let Some(rest) = path.strip_prefix("~/") {
        if let Some(h) = home {
            return h.join(rest);
        }
    }
    PathBuf::from(path)
}

fn home_from_env() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
        .map(PathBuf::from)
}

/// 将以 `~` 开头的路径展开为绝对路径（基于 `$HOME`）。返回 `String`,
/// 供 `CommandBuilder::cwd`、git2 路径、编辑器路径等本地调用方使用。
pub fn expand_tilde(path: &str) -> String {
    let home = home_from_env();
    expand_tilde_with(path, home.as_deref())
        .to_string_lossy()
        .into_owned()
}

/// 同 [`expand_tilde`],但返回 `PathBuf`,供文件系统模块统一使用 `PathBuf`。
pub fn expand_tilde_path(path: &str) -> PathBuf {
    let home = home_from_env();
    expand_tilde_with(path, home.as_deref())
}

#[cfg(test)]
mod tests {
    use super::{expand_tilde, expand_tilde_with};
    use std::path::{Path, PathBuf};

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

    #[test]
    fn expand_tilde_with_uses_provided_home() {
        let h = Path::new("/custom/home");
        assert_eq!(
            expand_tilde_with("~", Some(h)),
            PathBuf::from("/custom/home")
        );
        assert_eq!(
            expand_tilde_with("~/x", Some(h)),
            PathBuf::from("/custom/home/x")
        );
        // None home → pass through literally.
        assert_eq!(expand_tilde_with("~", None), PathBuf::from("~"));
        assert_eq!(expand_tilde_with("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn expand_tilde_with_does_not_panic_on_multibyte_at_byte_2() {
        // Regression: old `&path[2..]` panicked on `~é` (multi-byte char at
        // byte 2). strip_prefix splits on a char boundary so this is safe.
        assert_eq!(expand_tilde_with("~é", None), PathBuf::from("~é"));
        assert_eq!(expand_tilde_with("~x", None), PathBuf::from("~x"));
    }
}
