//! CLI 路径解析（实施文档 §3.7.2，修 P0-4）。
//!
//! `cargo tauri dev`（继承终端 PATH）能找到 claude/codex/git，**不代表 Finder 双击
//! `.app` 能找到**——macOS GUI app 通常不继承用户 shell PATH。这不是"CLI 未装"，
//! 是 app bundle 环境问题。
//!
//! 解析优先级：
//! 1. 用户在设置里的绝对路径覆盖（UserOverride）
//! 2. 从 login shell 取到的 PATH（LoginShellPath）
//! 3. 系统 / 常见路径兜底（SystemPath）

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ResolveSource {
    UserOverride,
    LoginShellPath,
    SystemPath,
    NotFound,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCommand {
    pub name: String,
    pub path: Option<PathBuf>,
    pub source: ResolveSource,
}

/// 全局解析器状态：用户覆盖项 + 启动时探测到的 login-shell PATH。
#[derive(Default)]
pub struct ResolverState {
    inner: RwLock<ResolverInner>,
}

#[derive(Default)]
struct ResolverInner {
    /// 用户在设置里指定的绝对路径覆盖（name → abs path）。
    overrides: HashMap<String, PathBuf>,
    /// 启动时从 login shell 解析到的 PATH（用 `:` 分隔的目录）。
    login_path_dirs: Vec<PathBuf>,
}

impl ResolverState {
    /// 在 setup() 中尽早调用一次：探测 login shell PATH。
    pub fn init_login_path(&self) {
        let dirs = detect_login_shell_path();
        if let Ok(mut g) = self.inner.write() {
            g.login_path_dirs = dirs;
        }
    }

    pub fn set_override(&self, name: &str, path: PathBuf) {
        if let Ok(mut g) = self.inner.write() {
            g.overrides.insert(name.to_string(), path);
        }
    }

    /// 解析一个 CLI 名（claude / codex / git）。
    pub fn resolve(&self, name: &str) -> ResolvedCommand {
        let g = match self.inner.read() {
            Ok(g) => g,
            Err(_) => {
                return ResolvedCommand {
                    name: name.into(),
                    path: None,
                    source: ResolveSource::NotFound,
                }
            }
        };

        // ① 用户覆盖
        if let Some(p) = g.overrides.get(name) {
            if p.exists() {
                return ResolvedCommand {
                    name: name.into(),
                    path: Some(p.clone()),
                    source: ResolveSource::UserOverride,
                };
            }
        }

        // ② login shell PATH 里逐目录找
        for dir in &g.login_path_dirs {
            let cand = dir.join(name);
            if cand.is_file() {
                return ResolvedCommand {
                    name: name.into(),
                    path: Some(cand),
                    source: ResolveSource::LoginShellPath,
                };
            }
        }

        // ③ 进程当前 PATH（which）+ 常见路径兜底
        if let Ok(p) = which::which(name) {
            return ResolvedCommand {
                name: name.into(),
                path: Some(p),
                source: ResolveSource::SystemPath,
            };
        }
        for dir in common_bin_dirs() {
            let cand = dir.join(name);
            if cand.is_file() {
                return ResolvedCommand {
                    name: name.into(),
                    path: Some(cand),
                    source: ResolveSource::SystemPath,
                };
            }
        }

        ResolvedCommand {
            name: name.into(),
            path: None,
            source: ResolveSource::NotFound,
        }
    }
}

/// 从 login shell 解析 PATH（`$SHELL -ilc 'echo $PATH'`）。失败返回空。
fn detect_login_shell_path() -> Vec<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = std::process::Command::new(&shell)
        .args(["-ilc", "echo $PATH"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.trim()
                .split(':')
                .filter(|p| !p.is_empty())
                .map(PathBuf::from)
                .collect()
        }
        _ => Vec::new(),
    }
}

fn common_bin_dirs() -> Vec<PathBuf> {
    ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        .iter()
        .map(PathBuf::from)
        .collect()
}

// === Tauri commands ===

#[tauri::command]
pub fn resolve_bin(state: tauri::State<'_, ResolverState>, name: String) -> ResolvedCommand {
    state.resolve(&name)
}

/// 设置页一次性拿所有 agent CLI 的解析结果，name 使用前端 AgentCode。
#[tauri::command]
pub fn resolve_all_bins(state: tauri::State<'_, ResolverState>) -> Vec<ResolvedCommand> {
    const AGENTS: &[(&str, &str)] = &[
        ("CC", "claude"),
        ("CX", "codex"),
        ("AM", "amp"),
        ("GM", "gemini"),
        ("CP", "gh"),
        ("CR", "cursor"),
        ("DR", "droid"),
        ("OC", "opencode"),
        ("PI", "pi"),
        ("AG", "auggie"),
        ("DV", "devin"),
    ];
    AGENTS
        .iter()
        .map(|(code, bin)| {
            let mut r = state.resolve(bin);
            r.name = code.to_string();
            r
        })
        .collect()
}

#[tauri::command]
pub fn set_bin_override(state: tauri::State<'_, ResolverState>, name: String, path: String) {
    state.set_override(&name, PathBuf::from(path));
}
