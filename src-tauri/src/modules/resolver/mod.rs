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
use std::sync::{LazyLock, RwLock};

use serde::{Deserialize, Serialize};

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

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct AgentRegistryEntry {
    code: String,
    cli_bin: String,
}

const AGENT_REGISTRY_JSON: &str = include_str!("../../../../src/modules/agent/registry-data.json");

/// Parse the embedded agent registry once. The JSON is `include_str!`-baked at
/// build time (CI validates it), so this can't fail at runtime; memoizing avoids
/// re-parsing on every `resolve_all_bins` call.
static AGENT_REGISTRY: LazyLock<Vec<AgentRegistryEntry>> = LazyLock::new(|| {
    serde_json::from_str(AGENT_REGISTRY_JSON).expect("agent registry JSON must stay valid")
});

fn agent_registry_entries() -> Vec<AgentRegistryEntry> {
    AGENT_REGISTRY.clone()
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
///
/// `$SHELL` 是用户环境变量,本地应用理论上可信,但作为防御纵深,我们只接受
/// 绝对路径且位于可信 bin 目录内的 shell——避免 `$SHELL` 被设为恶意可执行
/// 路径时通过本函数执行任意代码。
fn detect_login_shell_path() -> Vec<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if !is_trusted_shell_path(&shell) {
        log::warn!("ignoring untrusted $SHELL={shell:?}, falling back to /bin/zsh");
        return detect_shell_path("/bin/zsh");
    }
    detect_shell_path(&shell)
}

/// 仅接受绝对路径、且位于系统或 Homebrew bin 目录内的 shell。这些目录
/// 通常只有管理员/Homebrew 可写,是 login shell 的合理来源。
fn is_trusted_shell_path(path: &str) -> bool {
    let Ok(canon) = std::fs::canonicalize(path) else {
        // 路径不存在时,只放行纯文件名(交给 PATH 查找)而非任意路径。
        return !path.contains('/') && !path.is_empty();
    };
    const TRUSTED_DIRS: &[&str] = &["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
    for dir in TRUSTED_DIRS {
        if canon.starts_with(std::path::Path::new(dir)) {
            return true;
        }
    }
    false
}

fn detect_shell_path(shell: &str) -> Vec<PathBuf> {
    let output = std::process::Command::new(shell)
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
    agent_registry_entries()
        .into_iter()
        .map(|agent| {
            let mut r = state.resolve(&agent.cli_bin);
            r.name = agent.code;
            r
        })
        .collect()
}

#[tauri::command]
pub fn set_bin_override(state: tauri::State<'_, ResolverState>, name: String, path: String) {
    state.set_override(&name, PathBuf::from(path));
}

#[cfg(test)]
mod tests {
    use super::agent_registry_entries;

    #[test]
    fn resolver_uses_shared_agent_registry_data() {
        let entries = agent_registry_entries();
        let pairs: Vec<(&str, &str)> = entries
            .iter()
            .map(|entry| (entry.code.as_str(), entry.cli_bin.as_str()))
            .collect();

        assert_eq!(entries.len(), 12);
        assert!(pairs.contains(&("CC", "claude")));
        assert!(pairs.contains(&("CX", "codex")));
        assert!(pairs.contains(&("CP", "gh")));
        assert!(pairs.contains(&("CR", "cursor-agent")));
        assert!(pairs.contains(&("DV", "devin")));
    }
}
