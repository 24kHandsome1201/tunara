//! Authentication matrix: publickey (ed25519 + RSA), password,
//! keyboard-interactive and ssh-agent against `target`. Every fixture user is
//! pinned server-side to exactly one method, so success proves the client
//! used that path rather than falling through to another.

use super::harness::{open, open_with, unique, Fixture, Responder, KBD_USER, KEY_USER, PW_USER};

const OPEN_PHASES: [&str; 6] = [
    "resolving",
    "connecting",
    "handshaking",
    "authenticating",
    "openingShell",
    "ready",
];

async fn assert_login(
    fixture: &Fixture,
    auth: super::super::auth::AuthOptions,
    expected_user: &str,
) {
    let (session, log) = open(fixture.target(auth, &unique("auth"))).await;
    let phases = log.phases();
    assert_eq!(
        phases,
        OPEN_PHASES,
        "open must walk every connection phase in order; events:\n  {}",
        log.describe()
    );
    let who = session.exec("id -un", 4096).await.expect("id -un");
    assert_eq!(who.trim(), expected_user);
    session.close().expect("close");
}

#[tokio::test]
async fn publickey_ed25519_authenticates() {
    let fixture = Fixture::load();
    assert_login(&fixture, fixture.ed25519_auth(), KEY_USER).await;
}

#[tokio::test]
async fn publickey_rsa_authenticates() {
    let fixture = Fixture::load();
    assert_login(&fixture, fixture.rsa_auth(), KEY_USER).await;
}

#[tokio::test]
async fn password_authenticates() {
    let fixture = Fixture::load();
    assert_login(
        &fixture,
        fixture.password_auth(&fixture.pw_password),
        PW_USER,
    )
    .await;
}

#[tokio::test]
async fn password_rejects_wrong_secret() {
    let fixture = Fixture::load();
    let (result, log) = open_with(
        fixture.target(
            fixture.password_auth("definitely-not-it"),
            &unique("auth-bad-pw"),
        ),
        Responder::default(),
    )
    .await;
    let error = result.err().expect("wrong password must fail");
    assert!(
        error.to_ascii_lowercase().contains("authentication"),
        "error should name the authentication stage: {error}"
    );
    assert!(
        !log.phases().iter().any(|phase| phase == "ready"),
        "no ready phase after a rejected password; events:\n  {}",
        log.describe()
    );
}

#[tokio::test]
async fn keyboard_interactive_answers_server_prompt() {
    let fixture = Fixture::load();
    let session_id = unique("auth-kbd");
    let (result, log) = open_with(
        fixture.target(fixture.keyboard_interactive_auth(), &session_id),
        Responder::keyboard_interactive(&fixture.kbd_password),
    )
    .await;
    let session = result.unwrap_or_else(|error| {
        panic!(
            "keyboard-interactive open failed: {error}\n  {}",
            log.describe()
        )
    });

    let prompts = log.of_type("keyboardInteractivePrompt");
    assert!(
        !prompts.is_empty(),
        "server must have issued at least one keyboard-interactive prompt"
    );
    let first = &prompts[0];
    assert_eq!(first["origin"]["user"], KBD_USER);
    assert_eq!(first["origin"]["hopRole"], "direct");
    assert_eq!(first["origin"]["logicalSessionId"], session_id.as_str());
    assert_eq!(first["origin"]["port"], fixture.target_port);
    let fields = first["prompts"].as_array().expect("prompts array");
    assert!(
        !fields.is_empty(),
        "PAM prompt must carry at least one field"
    );
    assert_eq!(fields[0]["echo"], false, "password prompts must not echo");

    let who = session.exec("id -un", 4096).await.expect("id -un");
    assert_eq!(who.trim(), KBD_USER);
    assert_eq!(log.phases().last().map(String::as_str), Some("ready"));
    session.close().expect("close");
}

#[tokio::test]
async fn keyboard_interactive_rejects_wrong_response() {
    let fixture = Fixture::load();
    let (result, log) = open_with(
        fixture.target(fixture.keyboard_interactive_auth(), &unique("auth-kbd-bad")),
        Responder::keyboard_interactive("definitely-not-it"),
    )
    .await;
    let error = result
        .err()
        .expect("wrong keyboard-interactive answer must fail");
    assert!(
        error.to_ascii_lowercase().contains("authentication"),
        "error should name the authentication stage: {error}"
    );
    assert!(
        !log.of_type("keyboardInteractivePrompt").is_empty(),
        "the client must have consulted the prompt path before failing"
    );
}

#[tokio::test]
async fn ssh_agent_authenticates() {
    let fixture = Fixture::load();
    assert!(
        std::env::var_os("SSH_AUTH_SOCK").is_some(),
        "run.sh must export SSH_AUTH_SOCK for the fixture agent"
    );
    assert_login(&fixture, fixture.agent_auth(), KEY_USER).await;
}
