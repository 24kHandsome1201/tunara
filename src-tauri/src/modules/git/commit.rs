//! Tests for the old Git write path's pathspec safety.
//!
//! Git commit/push are no longer exposed through Tauri IPC in the current
//! product boundary. The pathspec helper stays tested as a regression fixture in
//! case a future explicit write feature is reintroduced.

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
