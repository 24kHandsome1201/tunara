//! Read-only pane status from local terminal multiplexers (HerdR, tmux, Zellij).
//!
//! A multiplexer keeps pane-level OSC signals to itself, so the outer terminal
//! cannot see agent state or cwd inside its panes. Each adapter runs one
//! bounded, read-only CLI query (never sends keys or writes to a pane) and
//! reduces the output to the allow-listed [`MultiplexerPane`] shape before it
//! crosses IPC.

pub mod herdr;
pub mod tmux;
pub mod zellij;

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::resolver::ResolverState;

pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const MAX_PANES: usize = 128;
pub(crate) const MAX_FIELD_LEN: usize = 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MultiplexerKind {
    Herdr,
    Tmux,
    Zellij,
}

/// `agent_status` is one of `idle | working | blocked | done | running | unknown`.
/// HerdR reports lifecycle states itself; tmux/Zellij only expose the
/// foreground process, so a registry-matched agent there is `running`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerPane {
    pub pane_id: String,
    pub session_id: Option<String>,
    pub window_id: Option<String>,
    pub focused: bool,
    pub agent: Option<String>,
    pub agent_status: &'static str,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiplexerStatus {
    pub kind: MultiplexerKind,
    pub panes: Vec<MultiplexerPane>,
}

pub(crate) trait MultiplexerAdapter {
    const KIND: MultiplexerKind;
    const PROGRAM: &'static str;

    /// `None` when no server/session is reachable or the output is unrecognized.
    async fn collect(program: &Path) -> Option<Vec<MultiplexerPane>>;
}

/// Non-empty, length-capped, control-character-free text.
pub(crate) fn bounded_str(text: &str) -> Option<String> {
    (!text.is_empty() && text.len() <= MAX_FIELD_LEN && !text.chars().any(char::is_control))
        .then(|| text.to_string())
}

pub(crate) fn absolute_cwd(cwd: Option<String>) -> Option<String> {
    cwd.filter(|cwd| cwd.starts_with('/'))
}

/// Agent registry match for a foreground process name (basename only).
pub(crate) fn agent_for_process(command: &str) -> Option<String> {
    let name = command.rsplit('/').next().unwrap_or(command);
    super::agent::preflight::agent_for_command(name).map(str::to_string)
}

/// Runs `program args…` with no stdin, discarded stderr, a timeout and an
/// output cap. `None` on spawn failure, timeout, non-zero exit or oversize.
pub(crate) async fn run_read_only(program: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() && output.stdout.len() <= MAX_OUTPUT_BYTES => {
            Some(output.stdout)
        }
        _ => None,
    }
}

async fn status_for<A: MultiplexerAdapter>(resolver: &ResolverState) -> Option<MultiplexerStatus> {
    let program = resolver.resolve(A::PROGRAM).path?;
    let mut panes = A::collect(&program).await?;
    panes.truncate(MAX_PANES);
    Some(MultiplexerStatus {
        kind: A::KIND,
        panes,
    })
}

/// `None` when the multiplexer is not installed, not running, or its output is
/// not recognizable.
#[tauri::command]
pub async fn multiplexer_status(
    kind: MultiplexerKind,
    resolver: tauri::State<'_, ResolverState>,
) -> Result<Option<MultiplexerStatus>, String> {
    Ok(match kind {
        MultiplexerKind::Herdr => status_for::<herdr::Herdr>(&resolver).await,
        MultiplexerKind::Tmux => status_for::<tmux::Tmux>(&resolver).await,
        MultiplexerKind::Zellij => status_for::<zellij::Zellij>(&resolver).await,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_with_kind_and_camel_case_fields() {
        let status = MultiplexerStatus {
            kind: MultiplexerKind::Tmux,
            panes: vec![MultiplexerPane {
                pane_id: "%1".into(),
                session_id: Some("$0".into()),
                window_id: Some("@0".into()),
                focused: true,
                agent: Some("claude".into()),
                agent_status: "running",
                cwd: Some("/repo".into()),
            }],
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"kind":"tmux","panes":[{"paneId":"%1","sessionId":"$0","windowId":"@0",
                "focused":true,"agent":"claude","agentStatus":"running","cwd":"/repo"}]})
        );
        let kind: MultiplexerKind = serde_json::from_str("\"zellij\"").unwrap();
        assert_eq!(kind, MultiplexerKind::Zellij);
    }

    #[test]
    fn bounded_str_rejects_empty_oversize_and_control_text() {
        assert_eq!(bounded_str("ok").as_deref(), Some("ok"));
        assert_eq!(bounded_str(""), None);
        assert_eq!(bounded_str("a\u{1b}[31m"), None);
        assert_eq!(bounded_str(&"x".repeat(MAX_FIELD_LEN + 1)), None);
    }

    #[test]
    fn agent_detection_uses_registry_commands() {
        assert_eq!(agent_for_process("claude").as_deref(), Some("claude"));
        assert_eq!(
            agent_for_process("/usr/local/bin/codex").as_deref(),
            Some("codex")
        );
        assert_eq!(agent_for_process("zsh"), None);
        assert_eq!(agent_for_process("Claude"), None);
    }
}
