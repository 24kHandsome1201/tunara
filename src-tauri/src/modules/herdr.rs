//! Read-only bridge to the local HerdR server via `herdr api snapshot`.
//!
//! HerdR keeps pane-level OSC signals to itself, so the outer terminal cannot
//! see agent state or cwd inside its panes. The snapshot is reduced to a small
//! allow-listed shape before it crosses IPC.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use super::resolver::ResolverState;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PANES: usize = 128;
const MAX_FIELD_LEN: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrPaneStatus {
    pub pane_id: String,
    pub focused: bool,
    pub agent: Option<String>,
    pub agent_status: &'static str,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrStatus {
    pub panes: Vec<HerdrPaneStatus>,
}

fn bounded_string(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (!text.is_empty() && text.len() <= MAX_FIELD_LEN && !text.chars().any(char::is_control))
        .then(|| text.to_string())
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

fn parse_snapshot(stdout: &[u8]) -> Option<HerdrStatus> {
    let root: Value = serde_json::from_slice(stdout).ok()?;
    let panes = root.pointer("/result/snapshot/panes")?.as_array()?;
    let panes = panes
        .iter()
        .take(MAX_PANES)
        .filter_map(|pane| {
            Some(HerdrPaneStatus {
                pane_id: bounded_string(pane.get("pane_id")?)?,
                focused: pane
                    .get("focused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                agent: pane.get("agent").and_then(bounded_string),
                agent_status: pane.get("agent_status").map_or("unknown", agent_status),
                cwd: pane
                    .get("foreground_cwd")
                    .and_then(bounded_string)
                    .or_else(|| pane.get("cwd").and_then(bounded_string))
                    .filter(|cwd| cwd.starts_with('/')),
            })
        })
        .collect();
    Some(HerdrStatus { panes })
}

/// `None` when herdr is not installed, no server is running, or the output is
/// not a recognizable snapshot.
#[tauri::command]
pub async fn herdr_status(
    resolver: tauri::State<'_, ResolverState>,
) -> Result<Option<HerdrStatus>, String> {
    let Some(program) = resolver.resolve("herdr").path else {
        return Ok(None);
    };
    let mut command = Command::new(program);
    command
        .args(["api", "snapshot"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(SNAPSHOT_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => return Ok(None),
    };
    Ok(parse_snapshot(&output.stdout))
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
        let status = parse_snapshot(raw).unwrap();
        assert_eq!(
            status.panes,
            vec![
                HerdrPaneStatus {
                    pane_id: "w1:p1".into(),
                    focused: true,
                    agent: Some("claude".into()),
                    agent_status: "blocked",
                    cwd: Some("/repo/sub".into()),
                },
                HerdrPaneStatus {
                    pane_id: "w1:p2".into(),
                    focused: false,
                    agent: None,
                    agent_status: "unknown",
                    cwd: None,
                },
            ]
        );
        assert!(!serde_json::to_string(&status)
            .unwrap()
            .contains("secret title"));
    }

    #[test]
    fn non_snapshot_output_is_ignored() {
        assert_eq!(parse_snapshot(b"not json"), None);
        assert_eq!(parse_snapshot(br#"{"error":{"code":"no_server"}}"#), None);
    }
}
