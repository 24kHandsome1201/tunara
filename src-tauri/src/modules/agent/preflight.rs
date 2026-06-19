//! Agent 三层预检（实施文档 §3.3.4，修 P1）：① 可执行存在 → ② 登录态 → ③ 版本（可选）。
//!
//! 与裸 `which` 的差别：可执行存在性走 [`ResolverState`]（§3.7.2），与 `agent_spawn`
//! 看到的解析结果一致——dev 能找到不代表打包 .app 能找到，反之亦然。登录态检查走
//! `ProcessRunner::run_capture` 统一超时，CLI 命令缺失/异常降级为"未知"，由 spawn 时再报。

use std::time::Duration;

use serde::Serialize;

use super::harness::AgentKind;
use crate::modules::process::{run_capture, CommandSpec};
use crate::modules::resolver::ResolverState;

/// 登录态检查的超时上限（CLI 偶发 hang 时不挂起预检）。
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")] // 修 P0(二轮)：logged_in → loggedIn，对齐前端 Preflight（§4.3）
pub struct Preflight {
    pub installed: bool,
    pub logged_in: bool,
    pub hint: Option<String>,
}

#[tauri::command]
pub async fn agent_preflight(
    resolver: tauri::State<'_, ResolverState>,
    agent: String,
) -> Result<Preflight, String> {
    let kind = AgentKind::from_code(&agent).ok_or("未知 agent")?;
    let bin = kind.bin();

    // ① 可执行存在：走 resolver（与 spawn 一致，含打包 .app 的 PATH 修复）。
    let resolved = resolver.resolve(bin);
    let Some(path) = resolved.path.clone() else {
        return Ok(Preflight {
            installed: false,
            logged_in: false,
            hint: Some(format!("未找到 {bin}，请先安装该 agent CLI（或在设置里指定路径）")),
        });
    };
    let program = path.to_string_lossy().into_owned();

    // ② 登录态：各 CLI 命令不同；命令缺失/异常则降级为"未知"，由 spawn 时再报。
    let login_args: &[&str] = match kind {
        AgentKind::Claude => &["auth", "status"], // claude auth status
        AgentKind::Codex => &["login", "status"], // codex login status（有凭证退出 0）
    };
    let logged_in = run_capture(
        CommandSpec::new(program).args(login_args.iter().map(|s| s.to_string())),
        PREFLIGHT_TIMEOUT,
    )
    .await
    .is_ok();

    // ③ 版本范围：可选，对照 §1.5 钉定版本给兼容性提示（此处略）。
    Ok(Preflight {
        installed: true,
        logged_in,
        hint: if logged_in {
            None
        } else {
            Some(format!("{bin} 似乎未登录，请先登录"))
        },
    })
}
