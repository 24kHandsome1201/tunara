//! ProxyJump through the `jump` container to `target` over direct-tcpip, plus
//! the failure attribution contract: a failing jump hop surfaces as
//! `RoutedOpenError::Jump`, a failing target hop as `RoutedOpenError::Target`.

use super::super::connection::RoutedOpenError;
use super::harness::{open, open_via_jump_with, unique, Fixture, Responder, KEY_USER};

#[tokio::test]
async fn proxy_jump_reaches_target_shell() {
    let fixture = Fixture::load();
    let session_id = unique("jump-ok");
    let (result, log) = open_via_jump_with(
        fixture.target_via_jump(fixture.ed25519_auth(), &session_id),
        fixture.jump(fixture.rsa_auth(), &session_id),
        Responder::default(),
    )
    .await;
    let routed =
        result.unwrap_or_else(|error| panic!("proxy jump failed: {error:?}\n  {}", log.describe()));

    let (direct, _direct_log) =
        open(fixture.target(fixture.ed25519_auth(), &unique("jump-ref"))).await;
    let (jump, _jump_log) = open(fixture.jump(fixture.ed25519_auth(), &unique("jump-hop"))).await;
    async fn hostname(session: &super::super::connection::SshSession) -> String {
        session
            .exec("uname -n", 4096)
            .await
            .expect("uname -n")
            .trim()
            .to_string()
    }
    let routed_host = hostname(&routed).await;
    let target_host = hostname(&direct).await;
    let jump_host = hostname(&jump).await;
    assert_eq!(routed_host, target_host, "routed shell must land on target");
    assert_ne!(
        routed_host, jump_host,
        "routed shell must not stop at the jump hop"
    );
    assert_ne!(
        target_host, jump_host,
        "fixture hops must be distinct containers"
    );

    let who = routed.exec("id -un", 4096).await.expect("id -un");
    assert_eq!(who.trim(), KEY_USER);
    // The target sees the connection arrive from the jump container, not from
    // the test host's published port.
    let peer = routed
        .exec("printf '%s' \"${SSH_CONNECTION%% *}\"", 4096)
        .await
        .expect("SSH_CONNECTION");
    assert!(
        !peer.is_empty() && !peer.starts_with("127."),
        "target should see the jump's overlay address, got {peer:?}"
    );

    let phases = log.phases();
    assert_eq!(phases.last().map(String::as_str), Some("ready"));
    assert!(
        phases
            .iter()
            .filter(|phase| *phase == "authenticating")
            .count()
            >= 2,
        "both hops authenticate; phases: {phases:?}"
    );

    routed.close().expect("close");
    direct.close().expect("close");
    jump.close().expect("close");
}

#[tokio::test]
async fn proxy_jump_failure_names_jump_hop() {
    let fixture = Fixture::load();
    let session_id = unique("jump-bad-jump");
    let (result, log) = open_via_jump_with(
        fixture.target_via_jump(fixture.ed25519_auth(), &session_id),
        fixture.jump(fixture.password_auth(&fixture.wrong_secret()), &session_id),
        Responder::default(),
    )
    .await;
    match result {
        Err(RoutedOpenError::Jump(message)) => assert!(
            message.to_ascii_lowercase().contains("authentication"),
            "jump failure should name the auth stage: {message}"
        ),
        Err(RoutedOpenError::Target(message)) => {
            panic!("jump auth failure was attributed to the target hop: {message}")
        }
        Ok(_) => panic!("wrong jump password must not connect"),
    }
    assert!(
        !log.phases().iter().any(|phase| phase == "ready"),
        "events:\n  {}",
        log.describe()
    );
}

#[tokio::test]
async fn proxy_jump_failure_names_target_hop() {
    let fixture = Fixture::load();
    let session_id = unique("jump-bad-target");
    let (result, log) = open_via_jump_with(
        fixture.target_via_jump(fixture.password_auth(&fixture.wrong_secret()), &session_id),
        fixture.jump(fixture.ed25519_auth(), &session_id),
        Responder::default(),
    )
    .await;
    match result {
        Err(RoutedOpenError::Target(message)) => assert!(
            message.to_ascii_lowercase().contains("authentication"),
            "target failure should name the auth stage: {message}"
        ),
        Err(RoutedOpenError::Jump(message)) => {
            panic!("target auth failure was attributed to the jump hop: {message}")
        }
        Ok(_) => panic!("wrong target password must not connect"),
    }
    let phases = log.phases();
    assert!(
        phases.iter().any(|phase| phase == "authenticating"),
        "the jump hop must have been reached first; phases: {phases:?}"
    );
    assert!(!phases.iter().any(|phase| phase == "ready"));
}
