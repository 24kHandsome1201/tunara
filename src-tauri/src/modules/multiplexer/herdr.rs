//! HerdR adapter: `herdr api snapshot` (JSON) from the local HerdR server.
//! HerdR tracks agent lifecycle itself, so its `agent_status` is passed through.
//! HerdR runs one server per user, so the query target is not used.

use std::path::Path;

use serde_json::Value;

use super::{
    absolute_cwd, bounded_str, run_read_only, MultiplexerAdapter, MultiplexerKind, MultiplexerPane,
    MultiplexerTarget,
};

pub struct Herdr;

impl MultiplexerAdapter for Herdr {
    const KIND: MultiplexerKind = MultiplexerKind::Herdr;
    const PROGRAM: &'static str = "herdr";

    async fn collect(program: &Path, _target: &MultiplexerTarget) -> Option<Vec<MultiplexerPane>> {
        parse_snapshot(&run_read_only(program, &["api", "snapshot"]).await?)
    }
}

fn bounded_string(value: &Value) -> Option<String> {
    bounded_str(value.as_str()?)
}

fn agent_status(value: &Value) -> &'static str {
    match value.as_str() {
        Some("idle") => "idle",
        Some("working") => "working",
        Some("blocked") => "blocked",
        Some("done") => "done",
        _ => "unknown",
    }
}

fn parse_snapshot(stdout: &[u8]) -> Option<Vec<MultiplexerPane>> {
    let root: Value = serde_json::from_slice(stdout).ok()?;
    let panes = root.pointer("/result/snapshot/panes")?.as_array()?;
    let panes = panes
        .iter()
        .take(super::MAX_PANES)
        .filter_map(|pane| {
            Some(MultiplexerPane {
                pane_id: bounded_string(pane.get("pane_id")?)?,
                session_id: None,
                window_id: None,
                focused: pane
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                agent: pane.get("agent").and_then(bounded_string),
                agent_status: pane.get("agent_status").map_or("unknown", agent_status),
                cwd: absolute_cwd(
                    pane.get("foreground_cwd")
                        .and_then(bounded_string)
                        .or_else(|| pane.get("cwd").and_then(bounded_string)),
                ),
            })
        })
        .collect();
    Some(panes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_is_reduced_to_allow_listed_pane_fields() {
        let raw = br#"{"id":"cli:api:snapshot","result":{"snapshot":{"panes":[
            {"pane_id":"w1:p1","focused":true,"agent":"claude","agent_status":"blocked",
             "cwd":"/repo","foreground_cwd":"/repo/sub","terminal_title":"secret title"},
            {"pane_id":"w1:p2","focused":false,"agent_status":"telepathic","cwd":"relative"},
            {"focused":true,"agent_status":"idle"}
        ]},"type":"session_snapshot"}}"#;
        let panes = parse_snapshot(raw).unwrap();
        assert_eq!(
            panes,
            vec![
                MultiplexerPane {
                    pane_id: "w1:p1".into(),
                    session_id: None,
                    window_id: None,
                    focused: true,
                    agent: Some("claude".into()),
                    agent_status: "blocked",
                    cwd: Some("/repo/sub".into()),
                },
                MultiplexerPane {
                    pane_id: "w1:p2".into(),
                    session_id: None,
                    window_id: None,
                    focused: false,
                    agent: None,
                    agent_status: "unknown",
                    cwd: None,
                },
            ]
        );
        assert!(!serde_json::to_string(&panes)
            .unwrap()
            .contains("secret title"));
    }

    #[test]
    fn non_snapshot_output_is_ignored() {
        assert_eq!(parse_snapshot(b"not json"), None);
        assert_eq!(parse_snapshot(br#"{"error":{"code":"no_server"}}"#), None);
    }
}
