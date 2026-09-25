//! Zellij adapter: `zellij list-sessions --no-formatting`, then
//! `zellij --session <name> action dump-layout` (KDL) for each live session.
//!
//! Limits: Zellij's CLI has no pane ids, so ids are synthesized as
//! `<session>:<tab>:<pane>` from layout order and may shift when panes move.
//! Commands come from the serialized layout (the pane's start command or the
//! detected foreground process); agent status is `running` on a registry
//! match. `focus=true` is only emitted while a client is attached; the first
//! listed session with a focused pane wins. At most [`MAX_SESSIONS`] sessions
//! are queried per poll.

use std::path::Path;
use std::time::Duration;

use super::{
    absolute_cwd, agent_for_process, bounded_str, run_read_only, MultiplexerAdapter,
    MultiplexerKind, MultiplexerPane,
};

const MAX_SESSIONS: usize = 4;
const MAX_SESSION_NAME_LEN: usize = 128;
const POLL_DEADLINE: Duration = Duration::from_secs(3);

pub struct Zellij;

impl MultiplexerAdapter for Zellij {
    const KIND: MultiplexerKind = MultiplexerKind::Zellij;
    const PROGRAM: &'static str = "zellij";

    async fn collect(program: &Path) -> Option<Vec<MultiplexerPane>> {
        tokio::time::timeout(POLL_DEADLINE, async {
            let sessions = parse_session_names(
                &run_read_only(program, &["list-sessions", "--no-formatting"]).await?,
            );
            if sessions.is_empty() {
                return None;
            }
            let mut panes = Vec::new();
            for session in sessions {
                let args = ["--session", session.as_str(), "action", "dump-layout"];
                if let Some(layout) = run_read_only(program, &args).await {
                    panes.extend(parse_dump_layout(&session, &layout));
                }
                if panes.len() >= super::MAX_PANES {
                    break;
                }
            }
            let mut focused_seen = false;
            for pane in &mut panes {
                if pane.focused {
                    pane.focused = !focused_seen;
                    focused_seen = true;
                }
            }
            Some(panes)
        })
        .await
        .ok()
        .flatten()
    }
}

/// Live session names; resurrectable (`EXITED`) sessions are skipped.
fn parse_session_names(stdout: &[u8]) -> Vec<String> {
    let Ok(text) = std::str::from_utf8(stdout) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.contains("EXITED"))
        .filter_map(|line| line.split_whitespace().next())
        .filter(|name| name.len() <= MAX_SESSION_NAME_LEN && !name.starts_with('-'))
        .filter_map(bounded_str)
        .take(MAX_SESSIONS)
        .collect()
}

/// One KDL node per line as emitted by `dump-layout`: `name attrs… [{]` or `}`.
#[derive(Debug, Default)]
struct Node {
    name: String,
    line: String,
    children: Vec<Node>,
}

fn parse_nodes(text: &str) -> Vec<Node> {
    let mut stack: Vec<Node> = vec![Node::default()];
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line == "}" {
            if stack.len() > 1 {
                let node = stack.pop().unwrap_or_default();
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                }
            }
            continue;
        }
        let opens = line.ends_with('{');
        let node = Node {
            name: line
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_string(),
            line: line.trim_end_matches('{').trim_end().to_string(),
            children: Vec::new(),
        };
        if opens {
            stack.push(node);
        } else if let Some(parent) = stack.last_mut() {
            parent.children.push(node);
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().unwrap_or_default();
        if let Some(parent) = stack.last_mut() {
            parent.children.push(node);
        }
    }
    stack.pop().map(|root| root.children).unwrap_or_default()
}

/// Value of `key="…"` on a node line (KDL string with `\"` / `\\` escapes).
fn attr(line: &str, key: &str) -> Option<String> {
    let needle = format!(" {key}=\"");
    let start = line.find(&needle)? + needle.len();
    let mut value = String::new();
    let mut chars = line[start..].chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return bounded_str(&value),
            '\\' => value.push(chars.next()?),
            _ => value.push(ch),
        }
        if value.len() > super::MAX_FIELD_LEN {
            return None;
        }
    }
    None
}

fn flag(line: &str, key: &str) -> bool {
    line.split_whitespace()
        .any(|token| token == format!("{key}=true"))
}

/// First positional string argument, e.g. `cwd "/repo"`.
fn positional(line: &str) -> Option<String> {
    let rest = line.split_once(' ')?.1.trim();
    attr(&format!(" v={rest}"), "v")
}

fn join_cwd(base: Option<&str>, cwd: Option<String>) -> Option<String> {
    match (base, cwd) {
        (_, Some(cwd)) if cwd.starts_with('/') => Some(cwd),
        (Some(base), Some(cwd)) => Some(format!("{}/{}", base.trim_end_matches('/'), cwd)),
        (base, None) => base.map(str::to_string),
        (None, Some(_)) => None,
    }
}

struct Walk<'a> {
    session: &'a str,
    tab: usize,
    tab_focused: bool,
    tab_cwd: Option<String>,
    panes: Vec<MultiplexerPane>,
}

impl Walk<'_> {
    fn visit(&mut self, nodes: &[Node]) {
        for node in nodes {
            match node.name.as_str() {
                "pane" => {
                    let container = node
                        .children
                        .iter()
                        .any(|child| matches!(child.name.as_str(), "pane" | "plugin" | "children"));
                    if container {
                        self.visit(&node.children);
                    } else {
                        self.leaf(&node.line);
                    }
                }
                "floating_panes" | "stacked" => self.visit(&node.children),
                _ => {}
            }
        }
    }

    fn leaf(&mut self, line: &str) {
        if self.panes.len() >= super::MAX_PANES {
            return;
        }
        let agent = attr(line, "command").and_then(|command| agent_for_process(&command));
        let pane_id = format!("{}:{}:{}", self.session, self.tab, self.panes.len());
        self.panes.push(MultiplexerPane {
            pane_id,
            session_id: Some(self.session.to_string()),
            window_id: Some(self.tab.to_string()),
            focused: self.tab_focused && flag(line, "focus"),
            agent_status: if agent.is_some() {
                "running"
            } else {
                "unknown"
            },
            agent,
            cwd: absolute_cwd(join_cwd(self.tab_cwd.as_deref(), attr(line, "cwd"))),
        });
    }
}

fn parse_dump_layout(session: &str, stdout: &[u8]) -> Vec<MultiplexerPane> {
    let Ok(text) = std::str::from_utf8(stdout) else {
        return Vec::new();
    };
    let nodes = parse_nodes(text);
    let Some(layout) = nodes.iter().find(|node| node.name == "layout") else {
        return Vec::new();
    };
    let layout_cwd = layout
        .children
        .iter()
        .find(|node| node.name == "cwd")
        .and_then(|node| positional(&node.line))
        .filter(|cwd| cwd.starts_with('/'));
    let mut walk = Walk {
        session,
        tab: 0,
        tab_focused: false,
        tab_cwd: None,
        panes: Vec::new(),
    };
    for (index, tab) in layout
        .children
        .iter()
        .filter(|node| node.name == "tab")
        .enumerate()
    {
        walk.tab = index;
        walk.tab_focused = flag(&tab.line, "focus");
        walk.tab_cwd = join_cwd(layout_cwd.as_deref(), attr(&tab.line, "cwd"));
        walk.visit(&tab.children);
    }
    walk.panes
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUMP: &str = r#"layout {
    cwd "/"
    tab name="Tab #1" focus=true hide_floating_panes=true {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane split_direction="vertical" {
            pane command="claude" cwd="Users/me/repo" focus=true size="50%" {
                args "--resume"
                start_suspended true
            }
            pane cwd="private/tmp" size="50%"
        }
        pane size=1 borderless=true {
            plugin location="zellij:status-bar"
        }
        floating_panes {
            pane name="Release Notes" {
                height 20
                plugin location="zellij:about" {
                    is_release_notes "true"
                }
            }
        }
    }
    tab name="Tab \"2\"" cwd="/srv" {
        pane command="/opt/bin/codex" focus=true
        pane cwd="app"
        pane
    }
    new_tab_template {
        pane command="claude"
    }
    swap_tiled_layout name="vertical" {
        tab max_panes=5 {
            pane
        }
    }
}
"#;

    #[test]
    fn dump_layout_yields_terminal_panes_with_agents_cwd_and_focus() {
        let panes = parse_dump_layout("work", DUMP.as_bytes());
        let summary: Vec<_> = panes
            .iter()
            .map(|p| {
                (
                    p.pane_id.as_str(),
                    p.window_id.as_deref(),
                    p.focused,
                    p.agent.as_deref(),
                    p.agent_status,
                    p.cwd.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "work:0:0",
                    Some("0"),
                    true,
                    Some("claude"),
                    "running",
                    Some("/Users/me/repo")
                ),
                (
                    "work:0:1",
                    Some("0"),
                    false,
                    None,
                    "unknown",
                    Some("/private/tmp")
                ),
                (
                    "work:1:2",
                    Some("1"),
                    false,
                    Some("codex"),
                    "running",
                    Some("/srv")
                ),
                (
                    "work:1:3",
                    Some("1"),
                    false,
                    None,
                    "unknown",
                    Some("/srv/app")
                ),
                ("work:1:4", Some("1"), false, None, "unknown", Some("/srv")),
            ]
        );
        assert!(panes
            .iter()
            .all(|p| p.session_id.as_deref() == Some("work")));
    }

    #[test]
    fn unrecognized_layout_yields_no_panes() {
        assert!(parse_dump_layout("s", b"not kdl").is_empty());
        assert!(parse_dump_layout("s", b"\xff").is_empty());
    }

    #[test]
    fn session_list_skips_exited_and_suspicious_names() {
        let raw = b"work [Created 3s ago] \nold [Created 1h ago] (EXITED - attach to resurrect)\n--help [Created 1s ago]\na\nb\nc\nd\ne\n";
        assert_eq!(parse_session_names(raw), vec!["work", "a", "b", "c"]);
        assert!(parse_session_names(b"").is_empty());
    }

    #[test]
    fn kdl_attr_handles_escapes_and_missing_keys() {
        assert_eq!(
            attr(r#"tab name="a \"b\"" x=1"#, "name").as_deref(),
            Some(r#"a "b""#)
        );
        assert_eq!(attr("pane size=1", "command"), None);
        assert_eq!(attr(r#"pane command="unterminated"#, "command"), None);
        assert_eq!(positional(r#"cwd "/repo""#).as_deref(), Some("/repo"));
    }
}
