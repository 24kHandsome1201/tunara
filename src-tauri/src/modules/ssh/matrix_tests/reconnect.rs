//! Passive disconnect: the remote sshd session process is killed from inside
//! the shell, the client must report `transportLost` and exit, and a reconnect
//! under the same logical session gets a fresh transport generation whose
//! binding is the only one the backend still honours.

use std::sync::Arc;
use std::time::Duration;

use super::super::connection::SshSession;
use super::super::sftp::{ssh_fs_read_dir, ssh_fs_write_text_file};
use super::harness::{open, unique, CommandApp, EventLog, Fixture, Terminal, BIG_DIR, SCRATCH_DIR};
use crate::modules::pty::Session;

const SHELL_TIMEOUT: Duration = Duration::from_secs(30);

fn ssh(session: &Arc<Session>) -> &SshSession {
    match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => panic!("matrix sessions are always SSH"),
    }
}

async fn assert_shell_alive(session: &SshSession, log: &EventLog, tag: &str) {
    let mut terminal = Terminal::new(session, log);
    terminal.send(&format!("echo {tag}-$((40+2))"));
    terminal.expect(&format!("{tag}-42"), SHELL_TIMEOUT).await;
}

#[tokio::test]
async fn passive_disconnect_then_reconnect_isolates_generations() {
    let fixture = Fixture::load();
    let app = CommandApp::new();
    let logical = unique("reconnect");

    let (first, first_log) = open(fixture.target(fixture.ed25519_auth(), &logical)).await;
    let first_binding = app.register(first, &logical, &format!("{logical}-gen-1"));
    let first_session = app.session(&first_binding).expect("gen-1 binding is live");
    assert_shell_alive(ssh(&first_session), &first_log, "GEN1").await;
    let listing = ssh_fs_read_dir(
        app.pty(),
        first_binding.physical_pty_id,
        BIG_DIR.into(),
        None,
    )
    .await
    .expect("gen-1 SFTP works before the cut");
    assert!(!listing.is_empty());

    // Kill the sshd session process that owns this shell: from the client's
    // point of view the transport simply vanishes without a clean EOF/exit.
    let before_kill = first_log.len();
    Terminal::new(ssh(&first_session), &first_log).send("kill -9 $PPID");
    let (_, lost) = first_log.wait_for_type(before_kill, "transportLost").await;
    assert_eq!(lost["reason"], "transportClosed");
    let (_, exit) = first_log.wait_for_type(before_kill, "exit").await;
    assert_eq!(
        exit["code"], -2,
        "SSH_DISCONNECTED_EXIT_CODE marks a passive loss"
    );
    let first_ssh = ssh(&first_session);
    assert!(first_ssh.transport_lost());
    tokio::time::timeout(SHELL_TIMEOUT, first_ssh.wait_closed())
        .await
        .expect("session closes after transport loss");
    assert!(first_ssh.is_closed());
    assert!(
        first_ssh.write(b"echo after-loss\n").is_err(),
        "writes to a lost transport must fail"
    );
    let settled = first_log.len();

    // Reconnect under the same logical session with a new generation.
    let (second, second_log) = open(fixture.target(fixture.ed25519_auth(), &logical)).await;
    let second_binding = app.register(second, &logical, &format!("{logical}-gen-2"));
    assert_eq!(second_binding.logical_session_id, logical);
    assert_ne!(
        second_binding.physical_pty_id,
        first_binding.physical_pty_id
    );
    assert_ne!(
        second_binding.transport_generation,
        first_binding.transport_generation
    );
    let second_session = app.session(&second_binding).expect("gen-2 binding is live");
    assert_shell_alive(ssh(&second_session), &second_log, "GEN2").await;

    // Generation isolation: the stale binding no longer resolves, and the
    // safe-write path refuses it with the generic SFTP write code rather than
    // touching the file through the new transport.
    assert!(
        app.session(&first_binding).is_none(),
        "gen-1 binding must be retired once gen-2 owns the logical session"
    );
    let stale = ssh_fs_write_text_file(
        app.pty(),
        first_binding.clone(),
        format!("{SCRATCH_DIR}/edit.txt"),
        "stale-generation-write\n".into(),
        "0000".into(),
    )
    .await;
    assert_eq!(stale, Err("SSH_SFTP_WRITE_FAILED".to_string()));
    let content = ssh(&second_session)
        .exec(&format!("cat {SCRATCH_DIR}/edit.txt"), 4096)
        .await
        .expect("cat");
    assert!(
        !content.contains("stale-generation-write"),
        "stale binding must not write through the new transport"
    );
    let listing = ssh_fs_read_dir(
        app.pty(),
        second_binding.physical_pty_id,
        BIG_DIR.into(),
        None,
    )
    .await
    .expect("gen-2 SFTP works");
    assert!(!listing.is_empty());
    assert!(
        ssh_fs_read_dir(
            app.pty(),
            first_binding.physical_pty_id,
            BIG_DIR.into(),
            None
        )
        .await
        .is_err(),
        "the retired physical id must not serve SFTP"
    );

    // Nothing from the dead transport leaks into the new generation's stream.
    assert_eq!(
        first_log.len(),
        settled,
        "gen-1 channel emitted events after it closed:\n  {}",
        first_log.describe()
    );
    assert!(second_log.of_type("transportLost").is_empty());
    ssh(&second_session).close().expect("close");
}
