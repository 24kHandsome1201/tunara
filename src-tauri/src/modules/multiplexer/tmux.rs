//! tmux adapter against the default tmux server:
//! `tmux list-clients -F …` binds the Tunara tab to the tmux session its
//! client is attached to (client tty == the tab's PTY tty), then
//! `tmux list-panes -s -t <session> -F …` lists that session's panes.
//!
//! Limits: the focused pane is the active pane of the session's active
//! window. Agent status is `running` when `pane_current_command` matches the
//! agent registry; tmux cannot tell working from waiting-for-input.

use std::path::Path;

use super::{
    absolute_cwd, agent_for_process, bounded_str, run_read_only, MultiplexerAdapter,
    MultiplexerKind, MultiplexerPane, MultiplexerTarget,
};

const CLIENT_FORMAT: &str = "#{client_tty}|#{session_id}";
/// tmux escapes tabs and other control characters in format output, so the
/// separator is a printable `|`; the path comes last so it may contain one.
const PANE_FORMAT: &str = "#{session_id}|#{window_id}|#{pane_id}|#{window_active}|#{pane_active}|#{pane_current_command}|#{pane_current_path}";

pub struct Tmux;

impl MultiplexerAdapter for Tmux {
    const KIND: MultiplexerKind = MultiplexerKind::Tmux;
    const PROGRAM: &'static str = "tmux";

    async fn collect(program: &Path, target: &MultiplexerTarget) -> Option<Vec<MultiplexerPane>> {
        let tty = target.tty.as_deref()?;
        let clients = run_read_only(program, &["list-clients", "-F", CLIENT_FORMAT]).await?;
        let session = client_session(&clients, tty)?;
        let args = [
            "list-panes",
            "-s",
            "-t",
            session.as_str(),
            "-F",
            PANE_FORMAT,
        ];
        parse_list_panes(&run_read_only(program, &args).await?, &session)
    }
}

fn tmux_id(value: &str, sigil: char) -> Option<String> {
    let digits = value.strip_prefix(sigil)?;
    (!digits.is_empty() && digits.len() <= 12 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| value.to_string())
}

/// Session id of the client attached on `tty`.
fn client_session(stdout: &[u8], tty: &str) -> Option<String> {
    std::str::from_utf8(stdout)
        .ok()?
        .lines()
        .filter_map(|line| line.split_once('|'))
        .find(|(client_tty, _)| *client_tty == tty)
        .and_then(|(_, session)| tmux_id(session, '$'))
}

fn parse_list_panes(stdout: &[u8], session_id: &str) -> Option<Vec<MultiplexerPane>> {
    let text = std::str::from_utf8(stdout).ok()?;
    let mut panes = Vec::new();
    let mut focus_seen = false;
    for line in text.lines() {
        if panes.len() >= super::MAX_PANES {
            break;
        }
        let fields: Vec<&str> = line.splitn(7, '|').collect();
        let [session, window, pane, window_active, pane_active, command, path] = fields[..] else {
            continue;
        };
        if session != session_id {
            continue;
        }
        let (Some(window_id), Some(pane_id)) = (tmux_id(window, '@'), tmux_id(pane, '%')) else {
            continue;
        };
        let focused = !focus_seen && window_active == "1" && pane_active == "1";
        focus_seen |= focused;
        let agent = bounded_str(command).and_then(|command| agent_for_process(&command));
        panes.push(MultiplexerPane {
            pane_id,
            session_id: Some(session_id.to_string()),
            window_id: Some(window_id),
            focused,
            agent_status: if agent.is_some() {
                "running"
            } else {
                "unknown"
            },
            agent,
            cwd: absolute_cwd(bounded_str(path)),
        });
    }
    Some(panes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(id: &str, window: &str, focused: bool) -> MultiplexerPane {
        MultiplexerPane {
            pane_id: id.into(),
            session_id: Some("$0".into()),
            window_id: Some(window.into()),
            focused,
            agent: None,
            agent_status: "unknown",
            cwd: None,
        }
    }

    #[test]
    fn client_tty_binds_to_its_attached_session() {
        let raw = b"/dev/ttys003|$1\n/dev/ttys012|$0\n/dev/ttys013|bogus\n";
        assert_eq!(client_session(raw, "/dev/ttys012").as_deref(), Some("$0"));
        assert_eq!(client_session(raw, "/dev/ttys003").as_deref(), Some("$1"));
        assert_eq!(client_session(raw, "/dev/ttys013"), None);
        assert_eq!(client_session(raw, "/dev/ttys099"), None);
        assert_eq!(client_session(b"\xff", "/dev/ttys012"), None);
    }

    #[test]
    fn list_panes_keeps_bound_session_and_focuses_active_pane_of_active_window() {
        let raw = b"$0|@0|%0|1|0|zsh|/private/tmp\n\
$0|@0|%1|1|1|claude|/Users/me/repo|with-pipe\n\
$0|@1|%2|0|1|codex|relative/path\n\
$1|@2|%3|1|1|opencode|/other-session\n\
$0|@3|%5|0|0|vim|/esc\x1b[31m\n\
garbage line\n\
$0|x5|%6|1|1|zsh|/bad-window-id\n";
        let panes = parse_list_panes(raw, "$0").unwrap();
        let mut first = pane("%0", "@0", false);
        first.cwd = Some("/private/tmp".into());
        let mut claude = pane("%1", "@0", true);
        claude.agent = Some("claude".into());
        claude.agent_status = "running";
        claude.cwd = Some("/Users/me/repo|with-pipe".into());
        let mut codex = pane("%2", "@1", false);
        codex.agent = Some("codex".into());
        codex.agent_status = "running";
        let vim = pane("%5", "@3", false);
        assert_eq!(panes, vec![first, claude, codex, vim]);
    }

    #[test]
    fn list_panes_caps_pane_count_and_rejects_non_utf8() {
        let line = "$0|@0|%1|1|1|zsh|/tmp\n";
        let raw = line.repeat(super::super::MAX_PANES + 10);
        assert_eq!(
            parse_list_panes(raw.as_bytes(), "$0").unwrap().len(),
            super::super::MAX_PANES
        );
        assert_eq!(parse_list_panes(b"$0|@0|%1|1|1|zsh|/\xff\n", "$0"), None);
        assert_eq!(parse_list_panes(b"", "$0").unwrap(), vec![]);
    }
}
