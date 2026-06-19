//! Git 写操作：commit + push 全走系统 `git` CLI（D4 + 修 P2-7 / P1-7）。
//!
//! 用 [`ProcessRunner::run_capture`] 统一 spawn/超时/kill/stderr 回显，CLI 路径
//! 走 [`ResolverState`]（打包 .app 也找得到 git）。
//! `GIT_TERMINAL_PROMPT=0` 禁交互——要凭证时立即失败而非挂起。

use std::time::Duration;

use crate::modules::process::{run_capture, CommandSpec};
use crate::modules::resolver::ResolverState;
use crate::modules::util::expand_tilde;

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// 内部统一 `git` 子命令执行：resolver 解析路径 + run_capture(超时真 kill)。
async fn run_git(resolver: &ResolverState, repo_path: &str, args: &[&str]) -> Result<String, String> {
    let resolved = resolver.resolve("git");
    let program = resolved
        .path
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| {
            "未找到 git（是否已安装 / PATH 可见？可在设置里指定路径）".to_string()
        })?;

    let repo_path = expand_tilde(repo_path);
    let spec = CommandSpec::new(program)
        .args(args.iter().map(|s| s.to_string()))
        .cwd(&repo_path)
        .env("GIT_TERMINAL_PROMPT", "0");

    run_capture(spec, GIT_TIMEOUT)
        .await
        .map(|o| o.stdout)
        .map_err(|e| e.to_string())
}

async fn run_git_owned(
    resolver: &ResolverState,
    repo_path: &str,
    args: Vec<String>,
) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(resolver, repo_path, &refs).await
}

fn git_add_args(files: &[String]) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Err("没有选择要提交的文件".into());
    }
    let mut args = Vec::with_capacity(files.len() + 2);
    args.push("add".into());
    args.push("--".into());
    for file in files {
        let trimmed = file.trim();
        if trimmed.is_empty() {
            return Err("提交文件路径不能为空".into());
        }
        args.push(trimmed.to_string());
    }
    Ok(args)
}

#[tauri::command]
pub async fn git_commit(
    resolver: tauri::State<'_, ResolverState>,
    repo_path: String,
    message: String,
    files: Vec<String>,
) -> Result<String, String> {
    let add_args = git_add_args(&files)?;
    run_git_owned(&resolver, &repo_path, add_args).await?;
    run_git(&resolver, &repo_path, &["commit", "-m", &message]).await
}

#[tauri::command]
pub async fn git_push(
    resolver: tauri::State<'_, ResolverState>,
    repo_path: String,
) -> Result<(), String> {
    run_git(&resolver, &repo_path, &["push"]).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::git_add_args;

    #[test]
    fn git_add_args_uses_explicit_pathspecs_only() {
        let args = git_add_args(&["src/main.ts".into(), "docs/readme.md".into()]).unwrap();
        assert_eq!(args, vec!["add", "--", "src/main.ts", "docs/readme.md"]);
        assert!(!args.iter().any(|arg| arg == "-A" || arg == "."));
    }

    #[test]
    fn git_add_args_rejects_empty_selection() {
        assert!(git_add_args(&[]).is_err());
    }

    #[test]
    fn git_add_args_rejects_blank_path() {
        assert!(git_add_args(&["src/main.ts".into(), "  ".into()]).is_err());
    }
}
