//! tmux adapter: `tmux list-panes -a -F …` against the default tmux server.
//!
//! Limits: only panes of sessions with an attached client are reported, and
//! the focused pane is the active pane of the most recently active attached
//! session (tmux has no notion of which client lives in which Tunara tab).
//! Agent status is `running` when `pane_current_command` matches the agent
//! registry; tmux cannot tell working from waiting-for-input.

use std::path::Path;

use super::{
    absolute_cwd, agent_for_process, bounded_str, run_read_only, MultiplexerAdapter,
    MultiplexerKind, MultiplexerPane,
};

/// tmux escapes tabs and other control characters in format output, so the
/// separator is a printable `|`; the path comes last so it may contain one.
const PANE_FORMAT: &str = "#{session_id}|#{window_id}|#{pane_id}|#{session_attached}|#{window_active}|#{pane_active}|#{session_activity}|#{pane_current_command}|#{pane_current_path}";

pub struct Tmux;

impl MultiplexerAdapter for Tmux {
    const KIND: MultiplexerKind = MultiplexerKind::Tmux;
    const PROGRAM: &'static str = "tmux";

    async fn collect(program: &Path) -> Option<Vec<MultiplexerPane>> {
        parse_list_panes(&run_read_only(program, &["list-panes", "-a", "-F", PANE_FORMAT]).await?)
    }
}

fn tmux_id(value: &str, sigil: char) -> Option<String> {
    let digits = value.strip_prefix(sigil)?;
    (!digits.is_empty() && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| value.to_string())
}

fn parse_list_panes(stdout: &[u8]) -> Option<Vec<MultiplexerPane>> {
    let text = std::str::from_utf8(stdout).ok()?;
    let mut panes = Vec::new();
    let mut focus: Option<(u64, usize)> = None;
    for line in text.lines() {
        if panes.len() >= super::MAX_PANES {
            break;
        }
        let fields: Vec<&str> = line.splitn(9, '|').collect();
        let [session, window, pane, attached, window_active, pane_active, activity, command, path] =
            fields[..]
        else {
            continue;
        };
        let (Some(session_id), Some(window_id), Some(pane_id)) = (
            tmux_id(session, '$'),
            tmux_id(window, '@'),
            tmux_id(pane, '%'),
        ) else {
            continue;
        };
        if attached.parse::<u32>().map_or(true, |count| count == 0) {
            continue;
        }
        let agent = bounded_str(command).and_then(|command| agent_for_process(&command));
        if window_active == "1" && pane_active == "1" {
            let activity = activity.parse::<u64>().unwrap_or(0);
            if focus.is_none_or(|(best, _)| activity > best) {
                focus = Some((activity, panes.len()));
            }
        }
        panes.push(MultiplexerPane {
            pane_id,
            session_id: Some(session_id),
            window_id: Some(window_id),
            focused: false,
            agent_status: if agent.is_some() {
                "running"
            } else {
                "unknown"
            },
            agent,
            cwd: absolute_cwd(bounded_str(path)),
        });
    }
    if let Some((_, index)) = focus {
        panes[index].focused = true;
    }
    Some(panes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, session: &str, window: &str, focused: bool) -> MultiplexerPane {
        MultiplexerPane {
            pane_id: id.into(),
            session_id: Some(session.into()),
            window_id: Some(window.into()),
            focused,
            agent: None,
            agent_status: "unknown",
            cwd: None,
        }
    }

    #[test]
    fn list_panes_keeps_attached_sessions_and_focuses_most_recent_active_pane() {
        let raw = b"$0|@0|%0|1|1|0|1790335000|zsh|/private/tmp\n\
$0|@0|%1|1|1|1|1790335000|claude|/Users/me/repo|with-pipe\n\
$0|@1|%2|1|0|1|1790335000|codex|relative/path\n\
$1|@2|%3|0|1|1|1790339999|opencode|/detached\n\
$2|@3|%4|2|1|1|1790336000|node|/other\n\
$3|@4|%5|1|1|1|oops|vim|/esc\x1b[31m\n\
garbage line\n\
x0|@5|%6|1|1|1|1|zsh|/bad-session-id\n";
        let panes = parse_list_panes(raw).unwrap();
        let mut first = pane("%0", "$0", "@0", false);
        first.cwd = Some("/private/tmp".into());
        let mut claude = pane("%1", "$0", "@0", false);
        claude.agent = Some("claude".into());
        claude.agent_status = "running";
        claude.cwd = Some("/Users/me/repo|with-pipe".into());
        let mut codex = pane("%2", "$0", "@1", false);
        codex.agent = Some("codex".into());
        codex.agent_status = "running";
        let mut node = pane("%4", "$2", "@3", true);
        node.cwd = Some("/other".into());
        let vim = pane("%5", "$3", "@4", false);
        assert_eq!(panes, vec![first, claude, codex, node, vim]);
    }

    #[test]
    fn list_panes_caps_pane_count_and_rejects_non_utf8() {
        let line = "$0|@0|%1|1|1|1|1|zsh|/tmp\n";
        let raw = line.repeat(super::super::MAX_PANES + 10);
        assert_eq!(
            parse_list_panes(raw.as_bytes()).unwrap().len(),
            super::super::MAX_PANES
        );
        assert_eq!(parse_list_panes(b"$0|@0|%1|1|1|1|1|zsh|/\xff\n"), None);
        assert_eq!(parse_list_panes(b"").unwrap(), vec![]);
    }
}
