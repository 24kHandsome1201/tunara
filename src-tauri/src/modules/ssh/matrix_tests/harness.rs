//! Shared plumbing for the real-SSH matrix: fixture discovery from the
//! environment exported by tests/ssh-matrix/run.sh, a recording `PtyEvent`
//! channel, prompt responders (host key + keyboard-interactive), an
//! interactive-shell reader, and a mock Tauri app for exercising the real
//! `#[tauri::command]` entry points with managed state.

use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::Notify;

use super::super::auth::{self, AuthMethod, AuthOptions};
use super::super::connection::{
    resolve_host_key_prompt, ConnectParams, HostKeyPolicy, RoutedOpenError, SshSession,
};
use super::super::diagnostics::SessionBindingV1;
use crate::modules::fs::grep::FsSearchCancellationState;
use crate::modules::pty::{PtyEvent, PtyState, Session};

pub(super) const OPEN_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const EVENT_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) const KEY_USER: &str = "keyuser";
pub(super) const PW_USER: &str = "pwuser";
pub(super) const KBD_USER: &str = "kbduser";
pub(super) const BIG_DIR: &str = "/srv/matrix/big";
pub(super) const BIG_DIR_FILES: usize = 9_990;
pub(super) const SCRATCH_DIR: &str = "/srv/matrix/scratch";

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("{name} is not set; launch the matrix through tests/ssh-matrix/run.sh")
    })
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

pub(super) struct Fixture {
    pub host: String,
    pub target_port: u16,
    pub jump_port: u16,
    pub keys_dir: PathBuf,
    pub pw_password: String,
    pub kbd_password: String,
    pub grep_budget: Duration,
    pub home: PathBuf,
}

impl Fixture {
    pub fn load() -> Self {
        let home = PathBuf::from(require_env("TUNARA_SSH_MATRIX_HOME"));
        let process_home = dirs::home_dir().expect("resolve home dir");
        assert_eq!(
            process_home, home,
            "HOME must point at TUNARA_SSH_MATRIX_HOME so known_hosts.rs and the download \
             sandbox use the throwaway directory; run tests/ssh-matrix/run.sh"
        );
        let keys_dir = PathBuf::from(require_env("TUNARA_SSH_MATRIX_KEYS"));
        assert!(
            keys_dir.join("id_ed25519").is_file() && keys_dir.join("id_rsa").is_file(),
            "fixture client keys missing in {}; run tests/ssh-matrix/keygen.sh",
            keys_dir.display()
        );
        let port = |name: &str, default: &str| -> u16 {
            env_or(name, default)
                .parse()
                .unwrap_or_else(|_| panic!("{name} must be a TCP port"))
        };
        Self {
            host: env_or("TUNARA_SSH_MATRIX_HOST", "127.0.0.1"),
            target_port: port("TUNARA_SSH_MATRIX_TARGET_PORT", "2201"),
            jump_port: port("TUNARA_SSH_MATRIX_JUMP_PORT", "2202"),
            keys_dir,
            pw_password: env_or("TUNARA_SSH_MATRIX_PW_PASSWORD", "tunara-matrix-pw"),
            kbd_password: env_or("TUNARA_SSH_MATRIX_KBD_PASSWORD", "tunara-matrix-kbd"),
            grep_budget: Duration::from_millis(
                env_or("TUNARA_SSH_MATRIX_GREP_BUDGET_MS", "3000")
                    .parse()
                    .expect("TUNARA_SSH_MATRIX_GREP_BUDGET_MS must be milliseconds"),
            ),
            home,
        }
    }

    pub fn key_path(&self, name: &str) -> String {
        self.keys_dir.join(name).display().to_string()
    }

    pub fn key_auth(&self, key_name: &str) -> AuthOptions {
        AuthOptions {
            user: KEY_USER.into(),
            method: AuthMethod::Key,
            identity_file: Some(self.key_path(key_name)),
            certificate_file: None,
            key_passphrase: None,
            password: None,
        }
    }

    pub fn ed25519_auth(&self) -> AuthOptions {
        self.key_auth("id_ed25519")
    }

    pub fn rsa_auth(&self) -> AuthOptions {
        self.key_auth("id_rsa")
    }

    pub fn agent_auth(&self) -> AuthOptions {
        AuthOptions {
            user: KEY_USER.into(),
            method: AuthMethod::Agent,
            identity_file: None,
            certificate_file: None,
            key_passphrase: None,
            password: None,
        }
    }

    pub fn password_auth(&self, password: &str) -> AuthOptions {
        AuthOptions {
            user: PW_USER.into(),
            method: AuthMethod::Password,
            identity_file: None,
            certificate_file: None,
            key_passphrase: None,
            password: Some(password.to_string()),
        }
    }

    pub fn keyboard_interactive_auth(&self) -> AuthOptions {
        AuthOptions {
            user: KBD_USER.into(),
            method: AuthMethod::KeyboardInteractive,
            identity_file: None,
            certificate_file: None,
            key_passphrase: None,
            password: None,
        }
    }

    fn params(&self, host: &str, port: u16, auth: AuthOptions, session_id: &str) -> ConnectParams {
        ConnectParams {
            host: host.to_string(),
            port,
            auth,
            policy: HostKeyPolicy::AcceptForTest,
            cols: 120,
            rows: 40,
            initial_cwd: None,
            inject_shell_integration: false,
            session_id: session_id.to_string(),
            transport_generation: format!("{session_id}-gen-1"),
            hop_role: "direct".into(),
            jump_endpoint: None,
        }
    }

    /// Direct connection to the `target` hop through its published port.
    pub fn target(&self, auth: AuthOptions, session_id: &str) -> ConnectParams {
        self.params(&self.host, self.target_port, auth, session_id)
    }

    /// Direct connection to the `jump` hop (used both as a ProxyJump hop and
    /// as "a different server" for host-key mismatch coverage).
    pub fn jump(&self, auth: AuthOptions, session_id: &str) -> ConnectParams {
        let mut params = self.params(&self.host, self.jump_port, auth, session_id);
        params.hop_role = "jump".into();
        params
    }

    /// The `target` hop as seen from inside the compose network, i.e. the
    /// endpoint the jump hop dials for direct-tcpip.
    pub fn target_via_jump(&self, auth: AuthOptions, session_id: &str) -> ConnectParams {
        let mut params = self.params("target", 22, auth, session_id);
        params.hop_role = "target".into();
        params.jump_endpoint = Some((self.host.clone(), self.jump_port, KEY_USER.into()));
        params
    }
}

/// Every `PtyEvent` the production code emitted, as serialized JSON, in
/// order. Readers scan from an index they remember so several waiters can
/// share one log without stealing each other's events.
#[derive(Clone, Default)]
pub(super) struct EventLog {
    events: Arc<Mutex<Vec<Value>>>,
    notify: Arc<Notify>,
}

impl EventLog {
    pub fn channel() -> (Channel<PtyEvent>, EventLog) {
        let log = EventLog::default();
        let sink = log.clone();
        let channel = Channel::<PtyEvent>::new(move |body| {
            let value: Value = match body {
                tauri::ipc::InvokeResponseBody::Json(json) => {
                    serde_json::from_str(&json).expect("PtyEvent JSON")
                }
                tauri::ipc::InvokeResponseBody::Raw(bytes) => {
                    serde_json::from_slice(&bytes).expect("PtyEvent JSON")
                }
            };
            sink.events.lock().expect("event log").push(value);
            sink.notify.notify_one();
            Ok(())
        });
        (channel, log)
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.events.lock().expect("event log").clone()
    }

    pub fn len(&self) -> usize {
        self.events.lock().expect("event log").len()
    }

    pub fn of_type(&self, kind: &str) -> Vec<Value> {
        self.snapshot()
            .into_iter()
            .filter(|event| event["type"] == kind)
            .collect()
    }

    /// First event at index >= `from` matching `pred`, waiting up to
    /// `timeout`. Panics with the full log on timeout so CI output explains
    /// which phase never happened.
    pub async fn wait_for<F>(&self, from: usize, timeout: Duration, pred: F) -> (usize, Value)
    where
        F: Fn(&Value) -> bool,
    {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let events = self.events.lock().expect("event log");
                if let Some((offset, event)) = events[from.min(events.len())..]
                    .iter()
                    .enumerate()
                    .find(|(_, event)| pred(event))
                {
                    return (from + offset, event.clone());
                }
            }
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                panic!(
                    "timed out after {}s waiting for event; log: {}",
                    timeout.as_secs(),
                    self.describe()
                );
            };
            let _ = tokio::time::timeout(remaining, self.notify.notified()).await;
        }
    }

    pub async fn wait_for_type(&self, from: usize, kind: &str) -> (usize, Value) {
        self.wait_for(from, EVENT_TIMEOUT, |event| event["type"] == kind)
            .await
    }

    pub fn describe(&self) -> String {
        self.snapshot()
            .iter()
            .map(|event| {
                if event["type"] == "data" {
                    format!("data({} bytes)", decode_data(event).len())
                } else {
                    event.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n  ")
    }

    pub fn phases(&self) -> Vec<String> {
        self.of_type("connectionStatus")
            .iter()
            .filter_map(|event| event["phase"].as_str().map(str::to_string))
            .collect()
    }
}

fn decode_data(event: &Value) -> Vec<u8> {
    event["data"]
        .as_str()
        .and_then(|encoded| B64.decode(encoded).ok())
        .unwrap_or_default()
}

pub(super) enum HostKeyAnswer {
    Accept { remember: bool },
    Reject,
}

/// Answers the interactive prompts production emits during `open`, exactly
/// like the frontend dialogs would (`ssh_host_key_decision`,
/// `ssh_keyboard_interactive_response`).
#[derive(Default)]
pub(super) struct Responder<'a> {
    pub keyboard_interactive_password: Option<&'a str>,
    pub host_key: Option<HostKeyAnswer>,
}

impl Responder<'_> {
    pub fn keyboard_interactive(password: &str) -> Responder<'_> {
        Responder {
            keyboard_interactive_password: Some(password),
            host_key: None,
        }
    }

    pub fn host_key(answer: HostKeyAnswer) -> Responder<'static> {
        Responder {
            keyboard_interactive_password: None,
            host_key: Some(answer),
        }
    }

    fn answer(&self, event: &Value) {
        match event["type"].as_str() {
            Some("keyboardInteractivePrompt") => {
                let prompt_id = event["promptId"].as_str().expect("promptId");
                let count = event["prompts"].as_array().map_or(0, Vec::len);
                let password = self
                    .keyboard_interactive_password
                    .unwrap_or_else(|| panic!("unexpected keyboard-interactive prompt: {event}"));
                let responses = (0..count).map(|_| password.to_string()).collect();
                assert!(
                    auth::resolve_keyboard_interactive_prompt(prompt_id, Some(responses)),
                    "keyboard-interactive prompt {prompt_id} was not pending"
                );
            }
            Some("hostKeyPrompt") => {
                let prompt_id = event["promptId"].as_str().expect("promptId");
                let (accept, remember) = match &self.host_key {
                    Some(HostKeyAnswer::Accept { remember }) => (true, *remember),
                    Some(HostKeyAnswer::Reject) => (false, false),
                    None => panic!("unexpected host key prompt: {event}"),
                };
                assert!(
                    resolve_host_key_prompt(prompt_id, accept, remember),
                    "host key prompt {prompt_id} was not pending"
                );
            }
            _ => {}
        }
    }
}

/// Polls `open` while answering prompts from the event log, bounded by
/// `OPEN_TIMEOUT`.
async fn drive<T, F>(open: F, log: &EventLog, responder: &Responder<'_>) -> T
where
    F: Future<Output = T>,
{
    tokio::pin!(open);
    let deadline = tokio::time::sleep(OPEN_TIMEOUT);
    tokio::pin!(deadline);
    let mut seen = 0usize;
    loop {
        tokio::select! {
            result = &mut open => return result,
            _ = &mut deadline => panic!(
                "SSH open timed out after {}s; events:\n  {}",
                OPEN_TIMEOUT.as_secs(),
                log.describe()
            ),
            _ = log.notify.notified() => {
                let events = log.snapshot();
                for event in &events[seen.min(events.len())..] {
                    responder.answer(event);
                }
                seen = events.len();
            }
        }
    }
}

pub(super) async fn open_with(
    params: ConnectParams,
    responder: Responder<'_>,
) -> (Result<SshSession, String>, EventLog) {
    let (channel, log) = EventLog::channel();
    let result = drive(SshSession::open(params, channel), &log, &responder).await;
    (result, log)
}

pub(super) async fn open(params: ConnectParams) -> (SshSession, EventLog) {
    let description = format!(
        "{}@{}:{} via {:?}",
        params.auth.user, params.host, params.port, params.auth.method
    );
    let (result, log) = open_with(params, Responder::default()).await;
    match result {
        Ok(session) => (session, log),
        Err(error) => panic!("open {description} failed: {error}\n  {}", log.describe()),
    }
}

pub(super) async fn open_via_jump_with(
    target: ConnectParams,
    jump: ConnectParams,
    responder: Responder<'_>,
) -> (Result<SshSession, RoutedOpenError>, EventLog) {
    let (channel, log) = EventLog::channel();
    let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
    let result = drive(
        SshSession::open_via_jump(target, jump, channel, cancel),
        &log,
        &responder,
    )
    .await;
    (result, log)
}

/// Reads the interactive shell like xterm.js would: decodes `Data` events,
/// acknowledges every delivered byte so the renderer-credit window never
/// stalls the pump, and lets tests wait for a marker string.
pub(super) struct Terminal<'a> {
    session: &'a SshSession,
    log: &'a EventLog,
    cursor: usize,
    acked: usize,
    buffer: Vec<u8>,
}

impl<'a> Terminal<'a> {
    pub fn new(session: &'a SshSession, log: &'a EventLog) -> Self {
        Self {
            session,
            log,
            cursor: 0,
            acked: 0,
            buffer: Vec::new(),
        }
    }

    fn pump(&mut self) {
        let events = self.log.snapshot();
        for event in &events[self.acked.min(events.len())..] {
            if event["type"] == "data" {
                let bytes = decode_data(event);
                self.session.acknowledge_output(bytes.len());
                self.buffer.extend(bytes);
            }
        }
        self.acked = events.len();
    }

    pub fn send(&self, line: &str) {
        self.session
            .write(format!("{line}\n").as_bytes())
            .expect("write to shell");
    }

    pub fn transcript(&self) -> String {
        String::from_utf8_lossy(&self.buffer).into_owned()
    }

    /// Waits until `needle` appears in the output received since the last
    /// call to `expect` (so a command's echo can be distinguished from its
    /// result by choosing a marker the echo cannot contain).
    pub async fn expect(&mut self, needle: &str, timeout: Duration) -> String {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            self.pump();
            let window =
                String::from_utf8_lossy(&self.buffer[self.cursor.min(self.buffer.len())..])
                    .into_owned();
            if let Some(index) = window.find(needle) {
                let consumed = self.cursor + window[..index + needle.len()].len();
                self.cursor = consumed;
                return window;
            }
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                panic!(
                    "timed out after {}s waiting for {needle:?} in shell output; transcript:\n{}\nevents:\n  {}",
                    timeout.as_secs(),
                    self.transcript(),
                    self.log.describe()
                );
            };
            let _ = tokio::time::timeout(remaining, self.log.notify.notified()).await;
        }
    }
}

/// Mock Tauri app carrying the same managed state the real binary registers,
/// so tests call the production `#[tauri::command]` functions with genuine
/// `State<'_, _>` handles and backend-issued bindings.
pub(super) struct CommandApp {
    app: tauri::App<tauri::test::MockRuntime>,
}

impl CommandApp {
    pub fn new() -> Self {
        let app = tauri::test::mock_app();
        app.manage(PtyState::default());
        app.manage(FsSearchCancellationState::default());
        Self { app }
    }

    pub fn pty(&self) -> tauri::State<'_, PtyState> {
        self.app.state::<PtyState>()
    }

    pub fn search(&self) -> tauri::State<'_, FsSearchCancellationState> {
        self.app.state::<FsSearchCancellationState>()
    }

    /// Publishes a session exactly like `ssh_open_v2` does and returns the
    /// binding the frontend would receive.
    pub fn register(
        &self,
        session: SshSession,
        logical_id: &str,
        transport_generation: &str,
    ) -> SessionBindingV1 {
        self.pty()
            .insert_ssh(
                Arc::new(Session::Ssh(session)),
                logical_id,
                transport_generation.to_string(),
            )
            .expect("insert ssh session")
    }

    pub fn session(&self, binding: &SessionBindingV1) -> Option<Arc<Session>> {
        self.pty().get_for_ssh_binding(binding)
    }
}

pub(super) fn unique(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "{prefix}-{}-{nanos}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}
