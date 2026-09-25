//! Remote shell matrix: the interactive PTY path with shell integration
//! injected into a real bash (`keyuser`) and a real zsh (`pwuser`). Asserts
//! the OSC 7 cwd report, the OSC 133 prompt/command boundaries and that the
//! bootstrap echo never reaches the terminal.

use std::time::Duration;

use super::super::auth::AuthOptions;
use super::super::connection::SshSession;
use super::harness::{open, unique, EventLog, Fixture, Terminal};

const PROMPT_MARKER: &str = "\x1b]133;A;tunara-shell";
const COMMAND_DONE_OK: &str = "\x1b]133;D;0;tunara-shell";
const CWD_MARKER: &str = "\x1b]7;file://localhost/srv/matrix";
const SHELL_TIMEOUT: Duration = Duration::from_secs(30);

async fn open_integrated(
    fixture: &Fixture,
    auth: AuthOptions,
    tag: &str,
) -> (SshSession, EventLog) {
    let mut params = fixture.target(auth, &unique(tag));
    params.inject_shell_integration = true;
    params.initial_cwd = Some("/srv/matrix".into());
    open(params).await
}

async fn assert_integrated_shell(session: &SshSession, log: &EventLog, version_probe: &str) {
    let mut terminal = Terminal::new(session, log);
    let first_prompt = terminal.expect(PROMPT_MARKER, SHELL_TIMEOUT).await;
    assert!(
        !first_prompt.contains("tunara-bootstrap") && !first_prompt.contains("/tmp/.t-"),
        "bootstrap marker and staged source line must be filtered out of the terminal: {first_prompt:?}"
    );
    // Spelled so the echoed command line cannot contain the expected output.
    terminal.send(&format!("echo MATRIX-$((40+2))-{version_probe}"));
    let output = terminal.expect("MATRIX-42-", SHELL_TIMEOUT).await;
    assert!(
        output.contains("\x1b]133;C"),
        "preexec must emit the OSC 133 C boundary: {output:?}"
    );
    let after = terminal.expect(COMMAND_DONE_OK, SHELL_TIMEOUT).await;
    assert!(
        after.contains(CWD_MARKER) || terminal.transcript().contains(CWD_MARKER),
        "precmd must report the initial cwd via OSC 7; transcript:\n{}",
        terminal.transcript()
    );
    let transcript = terminal.transcript();
    let version_line = transcript
        .lines()
        .find(|line| line.contains("MATRIX-42-") && !line.contains("$((40+2))"))
        .unwrap_or_else(|| panic!("no expanded MATRIX line in transcript:\n{transcript}"));
    assert!(
        version_line.trim_end().len() > "MATRIX-42-".len(),
        "shell version variable expanded to nothing: {version_line:?}"
    );
}

#[tokio::test]
async fn bash_interactive_shell_with_integration() {
    let fixture = Fixture::load();
    let (session, log) = open_integrated(&fixture, fixture.ed25519_auth(), "shell-bash").await;
    let shell = session
        .exec("getent passwd keyuser | cut -d: -f7", 4096)
        .await;
    assert_eq!(shell.expect("getent").trim(), "/bin/bash");
    assert_integrated_shell(&session, &log, "bash-$BASH_VERSION").await;
    session.close().expect("close");
}

#[tokio::test]
async fn zsh_interactive_shell_with_integration() {
    let fixture = Fixture::load();
    let (session, log) = open_integrated(
        &fixture,
        fixture.password_auth(&fixture.pw_password),
        "shell-zsh",
    )
    .await;
    let shell = session
        .exec("getent passwd pwuser | cut -d: -f7", 4096)
        .await;
    assert_eq!(shell.expect("getent").trim(), "/bin/zsh");
    assert_integrated_shell(&session, &log, "zsh-$ZSH_VERSION").await;
    session.close().expect("close");
}
