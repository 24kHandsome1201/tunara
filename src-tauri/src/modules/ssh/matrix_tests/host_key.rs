//! First-connect host key handling through the real `known_hosts.rs` store
//! in the throwaway `$HOME/.ssh/known_hosts`: TOFU accept (auto and via the
//! prompt dialog, remembered or session-only), rejection from the prompt,
//! and mismatch refusal when a host presents a key that differs from the
//! stored one. The tests share one store, so they serialize and reset it.

use std::path::PathBuf;

use super::super::connection::{ConnectParams, HostKeyPolicy};
use super::harness::{open_with, unique, EventLog, Fixture, HostKeyAnswer, Responder};

static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Store {
    path: PathBuf,
}

impl Store {
    fn reset(fixture: &Fixture) -> Self {
        let dir = fixture.home.join(".ssh");
        std::fs::create_dir_all(&dir).expect("create .ssh");
        let path = dir.join("known_hosts");
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    fn contents(&self) -> String {
        std::fs::read_to_string(&self.path).unwrap_or_default()
    }

    fn exists(&self) -> bool {
        self.path.is_file()
    }

    fn lines(&self) -> Vec<String> {
        self.contents()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_string)
            .collect()
    }
}

fn token(fixture: &Fixture, port: u16) -> String {
    format!("[{}]:{port}", fixture.host)
}

fn with_policy(mut params: ConnectParams, policy: HostKeyPolicy) -> ConnectParams {
    params.policy = policy;
    params
}

fn persistence_statuses(log: &EventLog) -> Vec<String> {
    log.of_type("hostKeyPersistence")
        .iter()
        .filter_map(|event| event["status"].as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
async fn accept_unknown_persists_then_matches_silently() {
    let _serial = STORE_LOCK.lock().await;
    let fixture = Fixture::load();
    let store = Store::reset(&fixture);

    let (first, log) = open_with(
        with_policy(
            fixture.target(fixture.ed25519_auth(), &unique("hk-tofu")),
            HostKeyPolicy::AcceptUnknown,
        ),
        Responder::default(),
    )
    .await;
    let first = first.expect("first connect under AcceptUnknown");
    assert_eq!(persistence_statuses(&log), ["saved"]);
    let persisted = &log.of_type("hostKeyPersistence")[0];
    assert_eq!(persisted["host"], fixture.host.as_str());
    assert_eq!(persisted["port"], fixture.target_port);
    assert!(log.of_type("hostKeyPrompt").is_empty());
    let lines = store.lines();
    assert_eq!(lines.len(), 1, "exactly one entry: {lines:?}");
    assert!(
        lines[0].starts_with(&format!("{} ssh-", token(&fixture, fixture.target_port))),
        "entry uses the [host]:port token: {}",
        lines[0]
    );
    first.close().expect("close");

    // Second contact under the default Prompt policy: a Match needs no dialog
    // and rewrites nothing.
    let (second, log) = open_with(
        with_policy(
            fixture.target(fixture.rsa_auth(), &unique("hk-match")),
            HostKeyPolicy::Prompt,
        ),
        Responder::default(),
    )
    .await;
    let second = second.expect("known host must connect without prompting");
    assert!(log.of_type("hostKeyPrompt").is_empty());
    assert!(log.of_type("hostKeyPersistence").is_empty());
    assert_eq!(store.lines(), lines);
    second.close().expect("close");
}

#[tokio::test]
async fn prompt_accept_and_remember_persists() {
    let _serial = STORE_LOCK.lock().await;
    let fixture = Fixture::load();
    let store = Store::reset(&fixture);

    let (result, log) = open_with(
        with_policy(
            fixture.target(fixture.ed25519_auth(), &unique("hk-prompt")),
            HostKeyPolicy::Prompt,
        ),
        Responder::host_key(HostKeyAnswer::Accept { remember: true }),
    )
    .await;
    let session = result.expect("accepted prompt must connect");
    let prompts = log.of_type("hostKeyPrompt");
    assert_eq!(prompts.len(), 1, "one prompt: {prompts:?}");
    assert_eq!(prompts[0]["reason"], "unknown");
    assert_eq!(prompts[0]["host"], fixture.host.as_str());
    assert_eq!(prompts[0]["port"], fixture.target_port);
    assert!(prompts[0]["fingerprint"]
        .as_str()
        .is_some_and(|fp| fp.starts_with("SHA256:")));
    assert!(prompts[0]["keyType"]
        .as_str()
        .is_some_and(|kind| kind.starts_with("ssh-") || kind.starts_with("ecdsa-")));
    assert_eq!(persistence_statuses(&log), ["saved"]);
    assert_eq!(store.lines().len(), 1);
    session.close().expect("close");
}

#[tokio::test]
async fn prompt_accept_session_only_does_not_persist() {
    let _serial = STORE_LOCK.lock().await;
    let fixture = Fixture::load();
    let store = Store::reset(&fixture);

    let (result, log) = open_with(
        with_policy(
            fixture.target(fixture.ed25519_auth(), &unique("hk-session-only")),
            HostKeyPolicy::Prompt,
        ),
        Responder::host_key(HostKeyAnswer::Accept { remember: false }),
    )
    .await;
    let session = result.expect("session-only acceptance must connect");
    assert_eq!(persistence_statuses(&log), ["sessionOnly"]);
    assert!(
        !store.exists() || store.lines().is_empty(),
        "session-only trust must not write known_hosts: {:?}",
        store.contents()
    );
    session.close().expect("close");
}

#[tokio::test]
async fn prompt_reject_refuses_connection() {
    let _serial = STORE_LOCK.lock().await;
    let fixture = Fixture::load();
    let store = Store::reset(&fixture);

    let (result, log) = open_with(
        with_policy(
            fixture.target(fixture.ed25519_auth(), &unique("hk-reject")),
            HostKeyPolicy::Prompt,
        ),
        Responder::host_key(HostKeyAnswer::Reject),
    )
    .await;
    let error = result.err().expect("rejected host key must fail the open");
    assert!(
        error.to_ascii_lowercase().contains("handshake"),
        "refusal surfaces as a handshake failure, not an auth failure: {error}"
    );
    assert_eq!(log.of_type("hostKeyPrompt").len(), 1);
    assert!(log.of_type("hostKeyPersistence").is_empty());
    assert!(!log.phases().iter().any(|phase| phase == "authenticating"));
    assert!(!store.exists() || store.lines().is_empty());
}

#[tokio::test]
async fn mismatched_key_is_refused_even_under_accept_unknown() {
    let _serial = STORE_LOCK.lock().await;
    let fixture = Fixture::load();
    let store = Store::reset(&fixture);

    // Learn the jump hop's real key, then claim `target` (reached through a
    // loopback alias so no concurrently running test resolves to the poisoned
    // token) presents that same key. Each container generates its own host
    // keys at start-up, so the two hops never share one.
    let (learned, _log) = open_with(
        with_policy(
            fixture.jump(fixture.ed25519_auth(), &unique("hk-mismatch-learn")),
            HostKeyPolicy::AcceptUnknown,
        ),
        Responder::default(),
    )
    .await;
    learned.expect("learn jump key").close().expect("close");
    let jump_line = store.lines().into_iter().next().expect("jump entry");
    let jump_key = jump_line
        .strip_prefix(&format!("{} ", token(&fixture, fixture.jump_port)))
        .expect("entry starts with the jump token")
        .to_string();
    let alias = if fixture.host == "localhost" {
        "127.0.0.1"
    } else {
        "localhost"
    };
    let forged = format!("[{alias}]:{} {jump_key}\n", fixture.target_port);
    std::fs::write(&store.path, format!("{jump_line}\n{forged}")).expect("seed known_hosts");
    let seeded = store.lines();

    let mut params = fixture.target(fixture.ed25519_auth(), &unique("hk-mismatch"));
    params.host = alias.into();
    let (result, log) = open_with(
        with_policy(params, HostKeyPolicy::AcceptUnknown),
        Responder::default(),
    )
    .await;
    let error = result.err().expect("mismatching host key must be refused");
    assert!(
        error.to_ascii_lowercase().contains("handshake"),
        "mismatch is refused during the handshake: {error}"
    );
    assert!(
        log.of_type("hostKeyPrompt").is_empty(),
        "mismatch never prompts"
    );
    assert!(
        log.of_type("hostKeyPersistence").is_empty(),
        "mismatch never rewrites the store"
    );
    assert!(!log.phases().iter().any(|phase| phase == "authenticating"));
    assert_eq!(store.lines(), seeded, "known_hosts must be left untouched");

    // Once the poisoned entry is gone the very same endpoint is trusted again
    // (TOFU), which pins the failure above on the store rather than the host.
    let store = Store::reset(&fixture);
    let mut params = fixture.target(fixture.ed25519_auth(), &unique("hk-mismatch-clean"));
    params.host = alias.into();
    let (retry, log) = open_with(
        with_policy(params, HostKeyPolicy::AcceptUnknown),
        Responder::default(),
    )
    .await;
    retry
        .unwrap_or_else(|error| panic!("alias unhealthy: {error}\n  {}", log.describe()))
        .close()
        .expect("close");
    assert_eq!(store.lines().len(), 1);
}
