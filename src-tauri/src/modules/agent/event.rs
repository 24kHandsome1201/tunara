//! 归一化 Agent 事件（实施文档 §3.3.1）。
//!
//! CC（claude）与 CX（codex）的原生 JSONL 行经 [`super::harness::AgentKind::parse_line`]
//! 解析后统一成这套 `AgentEvent`，通过 Tauri `Channel` 推给前端（契约见 §4.3）。
//!
//! 修 P0(二轮)：`rename_all="camelCase"` 只改 variant 名（started/delta/…），不改
//! struct variant 内的字段名。必须再加 `rename_all_fields="camelCase"`，否则
//! `agent_session_id`/`cost_usd` 仍以 snake_case 序列化，与前端契约
//! （agentSessionId/costUsd）对不上 → resume 拿不到 id 而失效。

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// 会话开始；session_id 供多轮 resume（CC=session_id / CX=thread_id）。
    Started { agent_session_id: Option<String> },
    /// 增量文本（打字机效果）。
    Delta { text: String },
    /// 工具调用（UI 折叠展示）。
    ToolUse { name: String, summary: Option<String> },
    /// 文件改动 → 触发 git diff 刷新。
    FileChange { path: String },
    /// 完成。
    Done {
        ok: bool,
        result: Option<String>,
        cost_usd: Option<f64>,
    },
    /// 失败。
    Failed { message: String },
}
