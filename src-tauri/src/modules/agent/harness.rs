//! Agent harness：CLI 命令构造 + 原生 JSONL → 归一化事件（实施文档 §3.3.2）。
//!
//! 每个 harness 负责：① 构造 CLI 命令（含 D1 的直接写盘 flag）；② 把该 CLI 的
//! 原生 JSONL 行解析成 [`AgentEvent`]。parser 只做事件归一化，不碰 UI 状态。
//!
//! 字段名对照 §1.5 钉定版本（Claude Code 2.1.178 / Codex 0.141.0）的 golden
//! fixtures 校正；缺字段返回 `None` 不 panic（CLI 字段漂移容错）。

use serde_json::Value;

use super::event::AgentEvent;

/// 支持的 agent（CU/Cursor 已砍，D2）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    pub fn from_code(c: &str) -> Option<Self> {
        match c {
            "CC" => Some(Self::Claude),
            "CX" => Some(Self::Codex),
            _ => None,
        }
    }

    /// 解析时用到的 CLI 名（实际路径经 resolver 解析，见 §3.7.2）。
    pub fn bin(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// 构造命令行参数（D1：均直接写盘）。
    pub fn args(&self, prompt: &str, resume: Option<&str>) -> Vec<String> {
        match self {
            // CC: stream-json + 自动接受编辑 + 可 resume
            Self::Claude => {
                let mut a = vec![
                    "-p".into(),
                    prompt.into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--verbose".into(),
                    "--include-partial-messages".into(),
                    "--permission-mode".into(),
                    "acceptEdits".into(), // D1 直接写盘
                ];
                if let Some(sid) = resume {
                    a.push("--resume".into());
                    a.push(sid.into());
                }
                a
            }
            // CX: exec --json + workspace-write；resume 用子命令形式（codex exec resume <thread_id> …）
            Self::Codex => {
                let mut a = vec!["exec".into()];
                if let Some(tid) = resume {
                    a.push("resume".into());
                    a.push(tid.into());
                }
                a.extend([
                    prompt.into(),
                    "--json".into(),
                    "--sandbox".into(),
                    "workspace-write".into(), // D1 直接写盘
                    "--skip-git-repo-check".into(), // P1：非 git 目录也能跑
                ]);
                a
            }
        }
    }

    /// 解析一行原生 JSONL → 归一化事件（`None` = 忽略该行）。
    ///
    /// 修 P1-9(二轮)：`FileChange` 是**优化事件不是唯一来源**——CC 不稳定产出文件
    /// 改动列表。diff 刷新主路径靠 "run 完成 + 窗口 focus + 会话激活 + commit/discard
    /// 后"（§4.4），并在 agent 结束时用 baseline delta 合成 FileChange（§3.4.3），
    /// 不依赖具体 CLI 字段。
    pub fn parse_line(&self, line: &str) -> Option<AgentEvent> {
        let v: Value = serde_json::from_str(line).ok()?;
        match self {
            Self::Claude => match v.get("type")?.as_str()? {
                "system" if v.get("subtype")?.as_str()? == "init" => Some(AgentEvent::Started {
                    agent_session_id: v
                        .get("session_id")
                        .and_then(|s| s.as_str())
                        .map(String::from),
                }),
                "stream_event" => {
                    let d = v.get("event")?.get("delta")?;
                    if d.get("type")?.as_str()? == "text_delta" {
                        Some(AgentEvent::Delta {
                            text: d.get("text")?.as_str()?.into(),
                        })
                    } else {
                        None
                    }
                }
                // 修 P1-9(二轮)：CC 的 tool_use 在 assistant 消息的 content 里，原来整段被
                // 忽略，导致"折叠 toolUse"对 CC 落空。这里取第一个 tool_use 块产出 ToolUse。
                // （一条 assistant 可能含多个块；MVP 取首个工具调用，多工具二期遍历 content。）
                "assistant" => {
                    let content = v.get("message")?.get("content")?.as_array()?;
                    content.iter().find_map(|c| {
                        if c.get("type")?.as_str()? == "tool_use" {
                            Some(AgentEvent::ToolUse {
                                name: c
                                    .get("name")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("tool")
                                    .into(),
                                summary: c.get("input").map(|i| i.to_string()),
                            })
                        } else {
                            None
                        }
                    })
                }
                "result" => {
                    let ok = !v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false)
                        && v.get("subtype").and_then(|s| s.as_str()) == Some("success");
                    Some(AgentEvent::Done {
                        ok,
                        result: v.get("result").and_then(|s| s.as_str()).map(String::from),
                        cost_usd: v.get("total_cost_usd").and_then(|n| n.as_f64()),
                    })
                }
                _ => None,
            },
            Self::Codex => match v.get("type")?.as_str()? {
                "thread.started" => Some(AgentEvent::Started {
                    agent_session_id: v
                        .get("thread_id")
                        .and_then(|s| s.as_str())
                        .map(String::from),
                }),
                "item.completed" => {
                    // file_change → FileChange；agent_message 文本 → Delta（CX 通常整段给）；
                    // command_execution / mcp_tool_call → ToolUse（修 P1-9：CX 工具调用也归一化）
                    let item = v.get("item")?;
                    match item.get("type")?.as_str()? {
                        "file_change" => Some(AgentEvent::FileChange {
                            path: item.get("path").and_then(|s| s.as_str()).unwrap_or("").into(),
                        }),
                        "agent_message" => Some(AgentEvent::Delta {
                            text: item.get("text").and_then(|s| s.as_str()).unwrap_or("").into(),
                        }),
                        "command_execution" => Some(AgentEvent::ToolUse {
                            name: "command".into(),
                            summary: item
                                .get("command")
                                .and_then(|s| s.as_str())
                                .map(String::from),
                        }),
                        "mcp_tool_call" => Some(AgentEvent::ToolUse {
                            name: item.get("tool").and_then(|s| s.as_str()).unwrap_or("mcp").into(),
                            summary: None,
                        }),
                        _ => None,
                    }
                }
                "turn.completed" => Some(AgentEvent::Done {
                    ok: true,
                    result: None,
                    cost_usd: None,
                }),
                // 修 P1-9(二轮)：提取真实错误字段，不再硬编码 "turn failed" 丢失诊断。
                "turn.failed" => Some(AgentEvent::Failed {
                    message: v
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|s| s.as_str())
                        .or_else(|| v.get("error").and_then(|s| s.as_str()))
                        .unwrap_or("turn failed")
                        .into(),
                }),
                _ => None,
            },
        }
    }
}
