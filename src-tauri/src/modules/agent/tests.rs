//! Agent harness 回归测试（实施文档 §7 / M4 验收）。
//!
//! 两类：
//! 1. **golden fixtures parser**：钉定版本（CC 2.1.178 / CX 0.141.0）的真实 JSONL
//!    行 → 归一化事件，覆盖 CC tool_use/编辑/错误、CX turn.failed 真实错误等。
//! 2. **wire snapshot**：`AgentEvent` 序列化必须是 camelCase（kind/agentSessionId/
//!    costUsd），否则前端 resume 拿不到 id 而静默失效（修 P0，二轮）。

use super::event::AgentEvent;
use super::harness::AgentKind;
use serde_json::{json, Value};

// ── 1. golden fixtures：CC（claude）──────────────────────────────────────

#[test]
fn cc_system_init_to_started() {
    let line = json!({
        "type": "system", "subtype": "init",
        "session_id": "sess_abc123", "cwd": "/tmp/x"
    })
    .to_string();
    assert_eq!(
        AgentKind::Claude.parse_line(&line),
        Some(AgentEvent::Started {
            agent_session_id: Some("sess_abc123".into())
        })
    );
}

#[test]
fn cc_stream_text_delta_to_delta() {
    let line = json!({
        "type": "stream_event",
        "event": { "type": "content_block_delta",
                   "delta": { "type": "text_delta", "text": "Hello" } }
    })
    .to_string();
    assert_eq!(
        AgentKind::Claude.parse_line(&line),
        Some(AgentEvent::Delta { text: "Hello".into() })
    );
}

#[test]
fn cc_stream_non_text_delta_ignored() {
    // input_json_delta 等非文本增量应被忽略（None），不 panic。
    let line = json!({
        "type": "stream_event",
        "event": { "delta": { "type": "input_json_delta", "partial_json": "{" } }
    })
    .to_string();
    assert_eq!(AgentKind::Claude.parse_line(&line), None);
}

#[test]
fn cc_assistant_tool_use_extracted() {
    // 修 P1-9：CC 的 tool_use 在 assistant.message.content 里，必须产出 ToolUse。
    let line = json!({
        "type": "assistant",
        "message": { "content": [
            { "type": "text", "text": "Let me edit that." },
            { "type": "tool_use", "name": "Edit",
              "input": { "file_path": "/tmp/a.rs", "old_string": "x" } }
        ]}
    })
    .to_string();
    let ev = AgentKind::Claude.parse_line(&line).expect("should parse tool_use");
    match ev {
        AgentEvent::ToolUse { name, summary } => {
            assert_eq!(name, "Edit");
            assert!(summary.is_some(), "tool_use summary 应带 input");
            assert!(summary.unwrap().contains("file_path"));
        }
        other => panic!("expected ToolUse, got {other:?}"),
    }
}

#[test]
fn cc_result_success_to_done_ok() {
    let line = json!({
        "type": "result", "subtype": "success", "is_error": false,
        "result": "Done editing.", "total_cost_usd": 0.0123
    })
    .to_string();
    assert_eq!(
        AgentKind::Claude.parse_line(&line),
        Some(AgentEvent::Done {
            ok: true,
            result: Some("Done editing.".into()),
            cost_usd: Some(0.0123),
        })
    );
}

#[test]
fn cc_result_error_to_done_not_ok() {
    // is_error / 非 success subtype → ok=false（CC 错误结果）。
    let line = json!({
        "type": "result", "subtype": "error_during_execution", "is_error": true
    })
    .to_string();
    assert_eq!(
        AgentKind::Claude.parse_line(&line),
        Some(AgentEvent::Done { ok: false, result: None, cost_usd: None })
    );
}

#[test]
fn cc_unknown_type_ignored() {
    let line = json!({ "type": "user", "message": {} }).to_string();
    assert_eq!(AgentKind::Claude.parse_line(&line), None);
}

// ── 2. golden fixtures：CX（codex）──────────────────────────────────────

#[test]
fn cx_thread_started_to_started() {
    let line = json!({ "type": "thread.started", "thread_id": "th_xyz" }).to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::Started {
            agent_session_id: Some("th_xyz".into())
        })
    );
}

#[test]
fn cx_item_file_change_to_file_change() {
    let line = json!({
        "type": "item.completed",
        "item": { "type": "file_change", "path": "src/main.rs" }
    })
    .to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::FileChange { path: "src/main.rs".into() })
    );
}

#[test]
fn cx_item_agent_message_to_delta() {
    let line = json!({
        "type": "item.completed",
        "item": { "type": "agent_message", "text": "I changed the file." }
    })
    .to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::Delta { text: "I changed the file.".into() })
    );
}

#[test]
fn cx_item_command_execution_to_tooluse() {
    let line = json!({
        "type": "item.completed",
        "item": { "type": "command_execution", "command": "cargo test" }
    })
    .to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::ToolUse {
            name: "command".into(),
            summary: Some("cargo test".into()),
        })
    );
}

#[test]
fn cx_turn_completed_to_done() {
    let line = json!({ "type": "turn.completed" }).to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::Done { ok: true, result: None, cost_usd: None })
    );
}

#[test]
fn cx_turn_failed_extracts_real_error() {
    // 修 P1-9：提取真实 error.message，不再硬编码 "turn failed"。
    let line = json!({
        "type": "turn.failed",
        "error": { "message": "rate limit exceeded" }
    })
    .to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::Failed { message: "rate limit exceeded".into() })
    );
}

#[test]
fn cx_turn_failed_fallback_when_no_message() {
    let line = json!({ "type": "turn.failed", "error": {} }).to_string();
    assert_eq!(
        AgentKind::Codex.parse_line(&line),
        Some(AgentEvent::Failed { message: "turn failed".into() })
    );
}

// ── 3. 容错：缺字段 / 坏 JSON 不 panic ─────────────────────────────────

#[test]
fn malformed_json_returns_none() {
    assert_eq!(AgentKind::Claude.parse_line("not json{"), None);
    assert_eq!(AgentKind::Codex.parse_line(""), None);
}

#[test]
fn missing_fields_return_none_not_panic() {
    // type 缺失、嵌套字段缺失都应 None。
    assert_eq!(AgentKind::Claude.parse_line(&json!({}).to_string()), None);
    assert_eq!(
        AgentKind::Claude.parse_line(&json!({ "type": "stream_event" }).to_string()),
        None
    );
    assert_eq!(
        AgentKind::Codex.parse_line(&json!({ "type": "item.completed" }).to_string()),
        None
    );
}

// ── 4. wire snapshot：序列化必须 camelCase（resume 不失效的关键，修 P0）──

#[test]
fn wire_started_is_camel_case() {
    let v: Value = serde_json::to_value(AgentEvent::Started {
        agent_session_id: Some("s1".into()),
    })
    .unwrap();
    // tag = kind；字段 = agentSessionId（不是 agent_session_id）。
    assert_eq!(v["kind"], "started");
    assert_eq!(v["agentSessionId"], "s1");
    assert!(v.get("agent_session_id").is_none(), "不得有 snake_case 字段");
}

#[test]
fn wire_done_cost_is_camel_case() {
    let v: Value = serde_json::to_value(AgentEvent::Done {
        ok: true,
        result: Some("ok".into()),
        cost_usd: Some(0.5),
    })
    .unwrap();
    assert_eq!(v["kind"], "done");
    assert_eq!(v["costUsd"], 0.5);
    assert!(v.get("cost_usd").is_none(), "不得有 snake_case 字段");
}

#[test]
fn wire_all_variants_tagged() {
    // 每个 variant 序列化都带 kind tag，前端 discriminated union 才能分流。
    let cases = [
        (AgentEvent::Delta { text: "x".into() }, "delta"),
        (
            AgentEvent::ToolUse { name: "Edit".into(), summary: None },
            "toolUse",
        ),
        (AgentEvent::FileChange { path: "a".into() }, "fileChange"),
        (AgentEvent::Failed { message: "e".into() }, "failed"),
    ];
    for (ev, expected_kind) in cases {
        let v = serde_json::to_value(ev).unwrap();
        assert_eq!(v["kind"], expected_kind);
    }
}
