use super::*;
use crate::modules::ssh::auth::AuthMethod;
use russh::{server, Channel, ChannelId};
use std::sync::atomic::AtomicUsize;
use tokio::sync::Mutex;

struct FixtureServer {
    listener: Arc<Mutex<Option<tokio::net::TcpListener>>>,
    cancel_requests: Arc<AtomicUsize>,
    allow_cancel: bool,
}

impl server::Handler for FixtureServer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<server::Msg>,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn tcpip_forward(
        &mut self,
        _address: &str,
        port: &mut u32,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", *port as u16))
            .await
            .unwrap();
        *port = listener.local_addr().unwrap().port().into();
        *self.listener.lock().await = Some(listener);
        Ok(true)
    }

    async fn cancel_tcpip_forward(
        &mut self,
        _address: &str,
        _port: u32,
        _session: &mut server::Session,
    ) -> Result<bool, Self::Error> {
        self.cancel_requests.fetch_add(1, Ordering::SeqCst);
        if self.allow_cancel {
            self.listener.lock().await.take();
        }
        Ok(self.allow_cancel)
    }
}

async fn cancellation_scenario(allow_cancel: bool) -> (Result<(), String>, bool) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let remote_listener = Arc::new(Mutex::new(None));
    let requests = Arc::new(AtomicUsize::new(0));
    let handler = FixtureServer {
        listener: remote_listener.clone(),
        cancel_requests: requests.clone(),
        allow_cancel,
    };
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    let host_key = russh::keys::PrivateKey::new(
        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&seed).into(),
        "",
    )
    .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        ..Default::default()
    });
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let _ = server::run_stream(config, socket, handler)
            .await
            .unwrap()
            .await;
    });
    let session = SshSession::open(
        ConnectParams {
            host: "127.0.0.1".into(),
            port: addr.port(),
            auth: AuthOptions {
                user: "fixture".into(),
                method: AuthMethod::Auto,
                identity_file: None,
                certificate_file: None,
                key_passphrase: None,
                password: None,
            },
            policy: HostKeyPolicy::AcceptForTest,
            cols: 80,
            rows: 24,
            initial_cwd: None,
            inject_shell_integration: false,
            session_id: "scout-forward".into(),
            transport_generation: "scout-generation".into(),
            hop_role: "target".into(),
            jump_endpoint: None,
        },
        IpcChannel::new(|_| Ok(())),
    )
    .await
    .unwrap();
    let port = session.request_tcpip_forward("127.0.0.1", 0).await.unwrap();
    assert!(remote_listener.lock().await.is_some());
    let result = session.cancel_tcpip_forward("127.0.0.1", port).await;
    let still_bound = tokio::net::TcpListener::bind(("127.0.0.1", port as u16))
        .await
        .is_err();
    println!("allow_cancel={allow_cancel}, cancellation_requests={}, wrapper_result={result:?}, remote_port_still_bound={still_bound}", requests.load(Ordering::SeqCst));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    session.close().unwrap();
    server.abort();
    (result, still_bound)
}

#[tokio::test]
async fn accepted_cancel_releases_remote_port() {
    if run_isolated("accepted_cancel_releases_remote_port") {
        return;
    }
    let (result, still_bound) = cancellation_scenario(true).await;
    assert!(result.is_ok());
    assert!(!still_bound);
}

#[tokio::test]
async fn rejected_cancel_must_not_report_success() {
    if run_isolated("rejected_cancel_must_not_report_success") {
        return;
    }
    let (result, still_bound) = cancellation_scenario(false).await;
    assert!(still_bound);
    assert!(
        result.is_err(),
        "server denied cancellation and kept the remote listener; Stop must not report success"
    );
}

fn run_isolated(test_name: &str) -> bool {
    if std::env::var_os("TUNARA_CANCEL_TEST_CHILD").is_some() {
        return false;
    }
    let home =
        std::env::temp_dir().join(format!("tunara-cancel-{}-{test_name}", std::process::id()));
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    let home = home.canonicalize().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("modules::ssh::connection::session::cancel_tests::{test_name}"),
            "--nocapture",
        ])
        .env("TUNARA_CANCEL_TEST_CHILD", "1")
        .env("HOME", &home)
        .env("SSH_AUTH_SOCK", home.join("missing-agent"))
        .status()
        .unwrap();
    std::fs::remove_dir_all(home).unwrap();
    assert!(status.success());
    true
}
