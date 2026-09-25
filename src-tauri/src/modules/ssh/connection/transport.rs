use std::fmt::Display;
use std::future::Future;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::watch;

use super::host_key::ClientHandler;
use super::ops::wait_for_exec_cancel;
use super::session::ConnectParams;
use super::{await_stage, SSH_CHANNEL_SETUP_TIMEOUT};
use crate::modules::pty::PtyEvent;
use crate::modules::ssh::auth;
use crate::modules::ssh::reverse_forward::ReverseForwardHub;
const SSH_TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(135);
// Keyboard-interactive may wait up to 120s for a user response. Keep the outer
// stage timeout slightly longer so it does not cancel a still-valid challenge.

// Keyboard-interactive may wait up to 120s for a user response. Keep the outer
// stage timeout slightly longer so it does not cancel a still-valid challenge.
const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(135);

async fn close_forward_channel_owned(channel: russh::Channel<russh::client::Msg>) {
    // A channel may be multiplexed with other interactive shells. Never
    // tear down the shared TCP transport merely because this channel's close
    // is slow; dropping the channel after the bounded close attempt cancels
    // only this open/relay.
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
}

pub(crate) struct ForwardChannel {
    channel: Option<russh::Channel<russh::client::Msg>>,
}

impl ForwardChannel {
    pub(crate) fn new(channel: russh::Channel<russh::client::Msg>) -> Self {
        Self {
            channel: Some(channel),
        }
    }

    pub(crate) fn into_inner(mut self) -> russh::Channel<russh::client::Msg> {
        self.channel.take().expect("forward channel is present")
    }

    pub(crate) async fn finish(mut self) {
        if let Some(channel) = self.channel.take() {
            close_forward_channel_owned(channel).await;
        }
    }
}

impl std::ops::Deref for ForwardChannel {
    type Target = russh::Channel<russh::client::Msg>;

    fn deref(&self) -> &Self::Target {
        self.channel.as_ref().expect("forward channel is present")
    }
}

impl std::ops::DerefMut for ForwardChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.channel.as_mut().expect("forward channel is present")
    }
}

impl Drop for ForwardChannel {
    fn drop(&mut self) {
        let Some(channel) = self.channel.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(close_forward_channel_owned(channel));
        }
    }
}

pub(crate) async fn await_pending_forward_open<C, F, S>(
    open: F,
    cancelled: &mut watch::Receiver<bool>,
    session_closed: S,
    timeout: Duration,
) -> Result<C, String>
where
    C: Send + 'static,
    F: Future<Output = Result<C, String>> + Send + 'static,
    S: Future<Output = ()>,
{
    let mut worker = tokio::spawn(open);
    tokio::select! {
        biased;
        _ = cancelled.changed() => {
            // Dropping the JoinHandle detaches this single open. Its eventual
            // channel value is dropped (and therefore channel-closed) without
            // touching any other channel on the multiplexed transport.
            Err("local forward cancelled".into())
        },
        _ = session_closed => Err("SSH session closed".into()),
        _ = tokio::time::sleep(timeout) => Err("SSH port forward channel timed out".into()),
        result = &mut worker => result
            .map_err(|error| format!("SSH forward channel task failed: {error}"))?,
    }
}

pub(crate) async fn await_pending_shell_open(
    handle: Arc<Handle<ClientHandler>>,
    cancelled: &mut watch::Receiver<bool>,
    disconnected: &mut watch::Receiver<bool>,
) -> Result<ForwardChannel, String> {
    if *cancelled.borrow() {
        return Err("SSH connection canceled".into());
    }
    if *disconnected.borrow() {
        return Err("SSH session closed".into());
    }
    let mut worker = tokio::spawn(async move {
        handle
            .channel_open_session()
            .await
            .map(ForwardChannel::new)
            .map_err(|error| format!("open session channel failed: {error}"))
    });
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("SSH connection canceled".into()),
        _ = disconnected.changed() => Err("SSH session closed".into()),
        _ = tokio::time::sleep(SSH_CHANNEL_SETUP_TIMEOUT) => Err(format!(
            "open session channel timed out after {}s",
            SSH_CHANNEL_SETUP_TIMEOUT.as_secs()
        )),
        result = &mut worker => result
            .map_err(|error| format!("open session channel task failed: {error}"))?,
    }
}

pub(crate) async fn await_pending_exec_open(
    handle: Arc<Handle<ClientHandler>>,
    cancelled: Option<&AtomicBool>,
) -> Result<ForwardChannel, String> {
    let mut worker = tokio::spawn(async move {
        handle
            .channel_open_session()
            .await
            .map(ForwardChannel::new)
            .map_err(|error| format!("open exec channel failed: {error}"))
    });
    let cancellation = wait_for_exec_cancel(cancelled);
    tokio::pin!(cancellation);
    tokio::select! {
        biased;
        _ = &mut cancellation => Err("remote command cancelled".into()),
        _ = tokio::time::sleep(SSH_CHANNEL_SETUP_TIMEOUT) => Err(format!(
            "open exec channel timed out after {}s",
            SSH_CHANNEL_SETUP_TIMEOUT.as_secs()
        )),
        result = &mut worker => result
            .map_err(|error| format!("open exec channel task failed: {error}"))?,
    }
}

pub(crate) async fn await_shell_setup_stage<T, E, F>(
    label: &str,
    cancelled: &mut watch::Receiver<bool>,
    disconnected: &mut watch::Receiver<bool>,
    future: F,
) -> Result<T, String>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    if *cancelled.borrow() {
        return Err("SSH connection canceled".into());
    }
    if *disconnected.borrow() {
        return Err("SSH session closed".into());
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("SSH connection canceled".into()),
        _ = disconnected.changed() => Err("SSH session closed".into()),
        result = await_stage(label, SSH_CHANNEL_SETUP_TIMEOUT, future) => result,
    }
}

#[derive(Debug)]
pub enum RoutedOpenError {
    Jump(String),
    Target(String),
}

pub(crate) async fn connect_authenticated_stream<S>(
    params: &ConnectParams,
    on_event: IpcChannel<PtyEvent>,
    cancel: tokio::sync::watch::Receiver<bool>,
    stream: S,
) -> Result<
    (
        Handle<ClientHandler>,
        watch::Receiver<bool>,
        Arc<std::sync::Mutex<Option<String>>>,
        ReverseForwardHub,
    ),
    String,
>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let verified_host_key = Arc::new(std::sync::Mutex::new(None));
    let (disconnected, disconnected_rx) = watch::channel(false);
    let reverse_hub = ReverseForwardHub::default();
    let handler = ClientHandler {
        host: params.host.clone(),
        port: params.port,
        policy: params.policy,
        on_event: on_event.clone(),
        verified_host_key: Arc::clone(&verified_host_key),
        cancel,
        disconnected,
        reverse_hub: reverse_hub.clone(),
    };
    send_connection_status(&on_event, "handshaking");
    let mut handle = await_stage(
        &format!("SSH handshake {}:{}", params.host, params.port),
        SSH_HANDSHAKE_TIMEOUT,
        client::connect_stream(config, stream, handler),
    )
    .await?;
    send_connection_status(&on_event, "authenticating");
    await_stage(
        "SSH authentication",
        SSH_AUTH_TIMEOUT,
        auth::authenticate(
            &mut handle,
            &params.auth,
            on_event,
            crate::modules::pty::KeyboardInteractiveOrigin {
                user: params.auth.user.clone(),
                host: params.host.clone(),
                port: params.port,
                logical_session_id: params.session_id.clone(),
                hop_role: params.hop_role.clone(),
                transport_generation: params.transport_generation.clone(),
            },
        ),
    )
    .await?;
    Ok((handle, disconnected_rx, verified_host_key, reverse_hub))
}

pub(crate) async fn connect_direct_authenticated(
    params: &ConnectParams,
    on_event: IpcChannel<PtyEvent>,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<
    (
        Handle<ClientHandler>,
        watch::Receiver<bool>,
        Arc<std::sync::Mutex<Option<String>>>,
        Arc<std::net::TcpStream>,
        ReverseForwardHub,
    ),
    String,
> {
    // Name resolution is its own stage so a DNS failure is not reported as
    // "connecting to host" in the failure bar and diagnostics.
    send_connection_status(&on_event, "resolving");
    let addrs = resolve_ssh_addrs(&params.host, params.port).await?;
    send_connection_status(&on_event, "connecting");
    let socket = tokio::time::timeout(
        SSH_TCP_CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect(addrs.as_slice()),
    )
    .await
    .map_err(|_| {
        format!(
            "connect {}:{} timed out after {}s",
            params.host,
            params.port,
            SSH_TCP_CONNECT_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("connect {}:{} failed: {e}", params.host, params.port))?;
    if let Err(e) = socket.set_nodelay(true) {
        log::debug!("ssh: set TCP_NODELAY failed: {e}");
    }
    let socket = socket
        .into_std()
        .map_err(|e| format!("prepare SSH transport abort failed: {e}"))?;
    let transport_abort = Arc::new(
        socket
            .try_clone()
            .map_err(|e| format!("prepare SSH transport abort failed: {e}"))?,
    );
    let socket = tokio::net::TcpStream::from_std(socket)
        .map_err(|e| format!("prepare SSH transport failed: {e}"))?;
    let (handle, disconnected, verified_host_key, reverse_hub) =
        connect_authenticated_stream(params, on_event, cancel, socket).await?;
    Ok((
        handle,
        disconnected,
        verified_host_key,
        transport_abort,
        reverse_hub,
    ))
}

/// Resolve `host:port` before TCP connect. Errors are prefixed with `resolve`
/// so the frontend can bucket them apart from refused/timed-out connects.
async fn resolve_ssh_addrs(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, String> {
    let addrs: Vec<_> = tokio::time::timeout(
        SSH_TCP_CONNECT_TIMEOUT,
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| {
        format!(
            "resolve {host}:{port} timed out after {}s",
            SSH_TCP_CONNECT_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| format!("resolve {host}:{port} failed: {e}"))?
    .collect();
    if addrs.is_empty() {
        return Err(format!("resolve {host}:{port} failed: no addresses"));
    }
    Ok(addrs)
}

pub(crate) fn send_connection_status(on_event: &IpcChannel<PtyEvent>, phase: &str) {
    let _ = on_event.send(PtyEvent::ConnectionStatus {
        phase: phase.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;
    #[tokio::test]
    async fn cancelling_pending_multiplex_open_closes_late_channel_only() {
        #[derive(Clone, Debug)]
        struct MockChannel {
            closed: Arc<AtomicBool>,
            transport_closed: Arc<AtomicBool>,
            main_shell_closed: Arc<AtomicBool>,
        }
        impl Drop for MockChannel {
            fn drop(&mut self) {
                self.closed.store(true, Ordering::Release);
                // Model CHANNEL_CLOSE: this channel owns neither shared state.
                let _ = (&self.transport_closed, &self.main_shell_closed);
            }
        }

        let transport_closed = Arc::new(AtomicBool::new(false));
        let main_shell_closed = Arc::new(AtomicBool::new(false));
        let late_closed = Arc::new(AtomicBool::new(false));
        let (late_tx, late_rx) = oneshot::channel::<MockChannel>();
        let (cancel_tx, mut cancel_rx) = watch::channel(false);
        let (session_close_tx, session_close_rx) = oneshot::channel::<()>();

        let pending = await_pending_forward_open(
            async move { late_rx.await.map_err(|_| "mock open lost".to_string()) },
            &mut cancel_rx,
            async move {
                let _ = session_close_rx.await;
            },
            Duration::from_secs(5),
        );
        tokio::pin!(pending);
        tokio::task::yield_now().await;

        // A second channel on the same mock multiplex remains genuinely usable
        // while the first open is pending and then cancelled.
        let (mut shell_client, mut shell_server) = tokio::io::duplex(64);
        shell_client.write_all(b"ping").await.expect("shell write");
        let mut input = [0; 4];
        shell_server
            .read_exact(&mut input)
            .await
            .expect("shell read");
        assert_eq!(&input, b"ping");
        shell_server.write_all(b"pong").await.expect("shell reply");
        shell_client
            .read_exact(&mut input)
            .await
            .expect("shell reply read");
        assert_eq!(&input, b"pong");

        cancel_tx.send(true).expect("pending open receiver alive");
        let result = tokio::time::timeout(Duration::from_millis(100), &mut pending)
            .await
            .expect("only pending open cancellation completes");
        assert_eq!(result.unwrap_err(), "local forward cancelled");

        late_tx
            .send(MockChannel {
                closed: late_closed.clone(),
                transport_closed: transport_closed.clone(),
                main_shell_closed: main_shell_closed.clone(),
            })
            .map_err(drop)
            .expect("detached open still receives late channel");
        tokio::time::timeout(Duration::from_millis(100), async {
            while !late_closed.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late channel is closed by dropped open result");

        assert!(!transport_closed.load(Ordering::Acquire));
        assert!(!main_shell_closed.load(Ordering::Acquire));
        drop(session_close_tx);
    }
    #[tokio::test]
    async fn ssh_resolution_is_a_named_stage_before_tcp_connect() {
        let addrs = resolve_ssh_addrs("127.0.0.1", 2222).await.unwrap();
        assert_eq!(addrs, vec!["127.0.0.1:2222".parse().unwrap()]);
        // `.invalid` never resolves (RFC 6761); the error must name resolution,
        // not "connect", so the failure bar reports the right stage.
        let err = resolve_ssh_addrs("qa-alias.invalid", 22).await.unwrap_err();
        assert!(err.starts_with("resolve qa-alias.invalid:22 "), "{err}");
        let source = include_str!("transport.rs");
        let resolving = source.find("send_connection_status(&on_event, \"resolving\")");
        let connecting = source.find("send_connection_status(&on_event, \"connecting\")");
        assert!(resolving.unwrap() < connecting.unwrap());
    }
}
