use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::Handle;
use russh::ChannelMsg;
use tauri::ipc::Channel as IpcChannel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use super::bootstrap::{
    bootstrap_completion_marker, initial_cwd_fallback_line, integration_source_line,
    stage_remote_bootstrap,
};
use super::host_key::{ClientHandler, HostKeyPolicy};
use super::ops::exec_on;
use super::transport::{
    await_pending_forward_open, await_pending_shell_open, await_shell_setup_stage,
    connect_authenticated_stream, connect_direct_authenticated, send_connection_status,
    ForwardChannel, RoutedOpenError,
};
use super::{await_stage, SSH_CHANNEL_SETUP_TIMEOUT};
use crate::modules::pty::output_flow::OutputFlow;
use crate::modules::pty::PtyEvent;
use crate::modules::ssh::auth::AuthOptions;
use crate::modules::ssh::flow_control::{
    SshBootstrapOutputFilter, SshControl, SshOutputBatch, INPUT_WRITE_CHUNK_BYTES,
    OUTPUT_BATCH_INTERVAL,
};
use crate::modules::ssh::reverse_forward::ReverseForwardHub;
#[derive(serde::Serialize)]
struct PosixRenameRequest<'a> {
    old_path: &'a str,
    new_path: &'a str,
}

fn encode_posix_rename_request(old_path: &str, new_path: &str) -> Result<Vec<u8>, String> {
    russh_sftp::ser::to_bytes(&PosixRenameRequest { old_path, new_path })
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("encode atomic rename request failed: {error}"))
}

/// GUI clients have no local tty whose termios we can copy. sshd applies only
/// the listed codes and leaves the rest at pty defaults; IUTF8 is the flag
/// that keeps CJK/IME input as UTF-8 instead of 8-bit garbage.
pub(crate) const SSH_PTY_MODES: [(russh::Pty, u32); 1] = [(russh::Pty::IUTF8, 1)];

const SSH_DISCONNECTED_EXIT_CODE: i32 = -2;

const SSH_FINAL_OUTPUT_FLUSH_TIMEOUT: Duration = Duration::from_millis(250);

const SSH_TRANSPORT_LOST_REASON: &str = "transportClosed";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PumpEnd {
    RemoteExit,
    LocalClose,
    ChannelEnded,
    TransportLost,
}

fn classify_pump_end(
    exit_code: Option<i32>,
    local_close: bool,
    _channel_ended: bool,
    transport_disconnected: bool,
) -> PumpEnd {
    if exit_code.is_some() {
        PumpEnd::RemoteExit
    } else if local_close {
        PumpEnd::LocalClose
    } else if transport_disconnected {
        PumpEnd::TransportLost
    } else {
        PumpEnd::ChannelEnded
    }
}

fn direct_tcpip_relay_complete(local_closed: bool, remote_closed: bool) -> bool {
    local_closed && remote_closed
}

/// Parameters to open an SSH session.
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub auth: AuthOptions,
    pub policy: HostKeyPolicy,
    pub cols: u16,
    pub rows: u16,
    /// Absolute remote directory restored after the interactive shell starts.
    /// A missing/unavailable directory degrades to the login home.
    pub initial_cwd: Option<String>,
    /// Inject remote shell integration so the remote shell emits OSC 7 / OSC
    /// 133 (cwd + command boundaries) and wraps agents to emit OSC 777
    /// lifecycle events. Default-on (see ssh_open_v2) — degrades silently on
    /// unsupported shells.
    pub inject_shell_integration: bool,
    /// Logical session id, substituted into the remote integration script so
    /// the OSC 777 agent events it emits carry a `session` field the frontend
    /// will accept (parseAgentLifecycleOsc drops mismatched sessions). Empty
    /// when unknown (reopen-less path); the agent wrappers then self-disable.
    pub session_id: String,
    pub transport_generation: String,
    pub hop_role: String,
    /// Secret-free jump identity used to decide whether two shells can share a TCP transport.
    pub jump_endpoint: Option<(String, u16, String)>,
}

/// A connected, authenticated SSH session with a live shell channel.
/// Owns the input sender (frontend keystrokes → channel) and resize/close
/// controls. The `Handle` stays alive so an SFTP channel can be opened on the
/// same connection (Phase 3).
pub struct SshSession {
    handle: Arc<Handle<ClientHandler>>,
    #[allow(dead_code)] // owns the duplicated socket for the transport lifetime
    transport_abort: Arc<std::net::TcpStream>,
    /// Retains the authenticated outer transport for a ProxyJump session. The
    /// target Handle's stream is a direct-tcpip channel owned by this handle,
    /// so dropping it would tear down the nested connection.
    _jump_handle: Option<Arc<Handle<ClientHandler>>>,
    control: Arc<SshControl>,
    output_flow: Arc<OutputFlow>,
    transport_lost: Arc<AtomicBool>,
    disconnected: watch::Receiver<bool>,
    host: String,
    port: u16,
    user: String,
    verified_host_key: String,
    logical_session_id: String,
    identity_file: Option<String>,
    jump_endpoint: Option<(String, u16, String)>,
    /// Lazily-opened SFTP subsystem on a SEPARATE channel of this connection.
    /// Guarded by an async mutex so concurrent fs commands serialize cleanly.
    /// Shared across multiplexed shells on the same TCP transport.
    sftp:
        std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>>,
    reverse_hub: ReverseForwardHub,
}

/// Cloneable pieces of an authenticated SSH TCP transport. A second interactive
/// shell opens another session channel on these Arcs instead of reconnecting.
#[derive(Clone)]
pub struct SharedSshTransport {
    handle: Arc<Handle<ClientHandler>>,
    transport_abort: Arc<std::net::TcpStream>,
    jump_handle: Option<Arc<Handle<ClientHandler>>>,
    sftp:
        std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>>,
    transport_lost: Arc<AtomicBool>,
    disconnected: watch::Receiver<bool>,
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    #[allow(dead_code)]
    user: String,
    verified_host_key: String,
    #[allow(dead_code)]
    identity_file: Option<String>,
    jump_endpoint: Option<(String, u16, String)>,
    reverse_hub: ReverseForwardHub,
}

async fn emit_output(
    output_flow: &OutputFlow,
    on_event: &IpcChannel<PtyEvent>,
    bytes: Vec<u8>,
) -> bool {
    let byte_len = bytes.len();
    if !output_flow.reserve(byte_len).await {
        return false;
    }
    let sent = on_event
        .send(PtyEvent::Data {
            data: B64.encode(bytes),
        })
        .is_ok();
    if !sent {
        output_flow.acknowledge(byte_len);
        output_flow.close();
    }
    sent
}

async fn bounded_final_flush<F>(output_flow: &OutputFlow, timeout: Duration, flush: F) -> bool
where
    F: Future<Output = bool>,
{
    let flushed = tokio::time::timeout(timeout, flush).await.unwrap_or(false);
    if !flushed {
        output_flow.close();
    }
    flushed
}

fn push_shell_output(
    output: &mut SshOutputBatch,
    bootstrap_filter: &mut Option<SshBootstrapOutputFilter>,
    data: &[u8],
) -> Vec<Vec<u8>> {
    let Some(filter) = bootstrap_filter.as_mut() else {
        return output.push(data);
    };
    let visible = filter.push(data);
    let complete = filter.is_complete();
    let ready = output.push(&visible);
    if complete {
        *bootstrap_filter = None;
    }
    ready
}

impl SshSession {
    /// Connect, authenticate, open a shell PTY, and start pumping output into
    /// `on_event`. Returns once the shell is live; output streaming continues
    /// on a background tokio task.
    #[allow(dead_code)] // retained for real-sshd fixtures and direct connector consumers
    pub async fn open(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
    ) -> Result<SshSession, String> {
        let (_cancel_tx, cancel) = tokio::sync::watch::channel(false);
        Self::open_with_cancel(params, on_event, cancel).await
    }

    pub async fn open_with_cancel(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        let (handle, disconnected, verified_host_key, transport_abort, reverse_hub) =
            connect_direct_authenticated(&params, on_event.clone(), cancel.clone()).await?;
        Self::open_authenticated(
            params,
            on_event,
            handle,
            disconnected,
            None,
            verified_host_key,
            transport_abort,
            reverse_hub,
            cancel,
        )
        .await
    }

    /// Connect the jump and target as independent SSH transports, then open a
    /// shell only on the target. Each hop runs its own host-key handler,
    /// authentication, and bounded handshake/auth stages.
    pub async fn open_via_jump(
        target: ConnectParams,
        jump: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<SshSession, RoutedOpenError> {
        let (jump_handle, _jump_disconnected, _jump_verified_host_key, transport_abort, _jump_hub) =
            connect_direct_authenticated(&jump, on_event.clone(), cancel.clone())
                .await
                .map_err(RoutedOpenError::Jump)?;
        let stream =
            crate::modules::ssh::direct_tcpip::into_stream(&jump_handle, &target.host, target.port)
                .await
                .map_err(RoutedOpenError::Jump)?;
        let (target_handle, target_disconnected, verified_host_key, reverse_hub) =
            connect_authenticated_stream(&target, on_event.clone(), cancel.clone(), stream)
                .await
                .map_err(RoutedOpenError::Target)?;
        Self::open_authenticated(
            target,
            on_event,
            target_handle,
            target_disconnected,
            Some(Arc::new(jump_handle)),
            verified_host_key,
            transport_abort,
            reverse_hub,
            cancel,
        )
        .await
        .map_err(RoutedOpenError::Target)
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_authenticated(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        handle: Handle<ClientHandler>,
        disconnected: watch::Receiver<bool>,
        jump_handle: Option<Arc<Handle<ClientHandler>>>,
        verified_host_key: Arc<std::sync::Mutex<Option<String>>>,
        transport_abort: Arc<std::net::TcpStream>,
        reverse_hub: ReverseForwardHub,
        cancel: watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        let handle = Arc::new(handle);
        let verified = verified_host_key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| "SSH server identity was not verified".to_string())?;
        Self::start_interactive_shell(
            params,
            on_event,
            SharedSshTransport {
                handle,
                transport_abort,
                jump_handle,
                sftp: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
                transport_lost: Arc::new(AtomicBool::new(false)),
                disconnected,
                host: String::new(),
                port: 0,
                user: String::new(),
                verified_host_key: verified,
                identity_file: None,
                jump_endpoint: None,
                reverse_hub,
            },
            cancel,
        )
        .await
    }

    pub async fn open_from_shared(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        shared: SharedSshTransport,
        cancel: watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        if shared.transport_lost.load(Ordering::Acquire) {
            return Err("SSH transport is no longer live".into());
        }
        send_connection_status(&on_event, "openingShell");
        Self::start_interactive_shell(params, on_event, shared, cancel).await
    }

    async fn start_interactive_shell(
        params: ConnectParams,
        on_event: IpcChannel<PtyEvent>,
        shared: SharedSshTransport,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<SshSession, String> {
        let handle = shared.handle.clone();
        let mut disconnected = shared.disconnected.clone();
        send_connection_status(&on_event, "openingShell");
        let channel =
            await_pending_shell_open(handle.clone(), &mut cancel, &mut disconnected).await?;
        if let Err(error) = await_shell_setup_stage(
            "request PTY",
            &mut cancel,
            &mut disconnected,
            channel.request_pty(
                false,
                "xterm-256color",
                params.cols as u32,
                params.rows as u32,
                0,
                0,
                &SSH_PTY_MODES,
            ),
        )
        .await
        {
            channel.finish().await;
            return Err(error);
        }
        if let Err(error) = await_shell_setup_stage(
            "request shell",
            &mut cancel,
            &mut disconnected,
            channel.request_shell(true),
        )
        .await
        {
            channel.finish().await;
            return Err(error);
        }

        // Stage shell integration and the saved cwd into one private bootstrap,
        // then type only a SHORT source line into the interactive shell. This
        // keeps long/unicode paths and the integration payload out of the tty's
        // canonical input limit. If staging is unavailable, a normal-sized cwd
        // still falls back to a directly typed, safely quoted `cd` command.
        let mut bootstrap_output_filter = None;
        if params.inject_shell_integration || params.initial_cwd.is_some() {
            let completion_marker = bootstrap_completion_marker(&params.session_id);
            let bootstrap_cancelled = AtomicBool::new(false);
            let bootstrap = stage_remote_bootstrap(
                &handle,
                &params.session_id,
                params.inject_shell_integration,
                params.initial_cwd.as_deref(),
                Some(&bootstrap_cancelled),
            );
            tokio::pin!(bootstrap);
            let staged = tokio::select! {
                biased;
                _ = cancel.changed() => {
                    bootstrap_cancelled.store(true, Ordering::Release);
                    let _ = (&mut bootstrap).await;
                    channel.finish().await;
                    return Err("SSH connection canceled".into());
                }
                _ = disconnected.changed() => {
                    bootstrap_cancelled.store(true, Ordering::Release);
                    let _ = (&mut bootstrap).await;
                    channel.finish().await;
                    return Err("SSH session closed".into());
                }
                result = &mut bootstrap => result,
            };
            match staged {
                Ok(path) => {
                    let line = integration_source_line(&path);
                    match await_shell_setup_stage(
                        "inject shell bootstrap",
                        &mut cancel,
                        &mut disconnected,
                        channel.data(line.as_bytes()),
                    )
                    .await
                    {
                        Ok(()) => {
                            bootstrap_output_filter = Some(SshBootstrapOutputFilter::new(
                                line.as_bytes(),
                                &completion_marker,
                            ));
                        }
                        Err(_) => log::debug!("ssh bootstrap inject failed"),
                    }
                }
                Err(_) => {
                    log::debug!("ssh bootstrap staging failed");
                    if let Some(cwd) = params.initial_cwd.as_deref() {
                        let line = initial_cwd_fallback_line(cwd, &params.session_id);
                        match await_shell_setup_stage(
                            "inject initial cwd",
                            &mut cancel,
                            &mut disconnected,
                            channel.data(line.as_bytes()),
                        )
                        .await
                        {
                            Ok(()) => {
                                bootstrap_output_filter = Some(SshBootstrapOutputFilter::new(
                                    line.as_bytes(),
                                    &completion_marker,
                                ));
                            }
                            Err(_) => {
                                log::debug!("ssh initial cwd fallback failed");
                            }
                        }
                    }
                }
            }
        }

        if *cancel.borrow() || *disconnected.borrow() {
            channel.finish().await;
            return Err(if *cancel.borrow() {
                "SSH connection canceled".into()
            } else {
                "SSH session closed".into()
            });
        }
        let mut channel = channel.into_inner();

        let (control, mut resize_rx) = SshControl::new();
        let pump_control = control.clone();
        let output_flow = OutputFlow::new();
        let pump_output_flow = output_flow.clone();
        let transport_lost = shared.transport_lost.clone();
        let pump_transport_lost = transport_lost.clone();
        let pump_handle = handle.clone();
        // Frontend listens for this `connectionStatus` / `ready` event and
        // persists the SSH host profile only after the shell is live.
        send_connection_status(&on_event, "ready");

        // Pump: remote output is coalesced behind a strict byte/time bound;
        // frontend Data, latest Resize, and Close each have independent control
        // paths. In particular, Close can cancel a channel.data().await parked
        // on SSH flow control instead of waiting behind a full paste queue.
        tauri::async_runtime::spawn(async move {
            // An interactive SSH channel can disappear without sending an
            // ExitStatus when the network or server dies. Keep that distinct
            // from a real zero exit so the UI never calls a disconnect clean.
            let mut exit_code: Option<i32> = None;
            // Stop forwarding frontend keystrokes once the remote shell is
            // exiting — otherwise a passive disconnect races with queued input
            // and the server may echo a burst of characters before the channel
            // closes. Output from channel.wait() keeps draining until Eof.
            let mut accepting_input = true;
            let mut output = SshOutputBatch::new();
            let mut flush_tick = tokio::time::interval(OUTPUT_BATCH_INTERVAL);
            flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            flush_tick.tick().await;
            let mut local_close = false;
            let mut confirmed_transport_lost = false;
            let mut connection_signal_open = true;
            let mut channel_ended = false;
            'pump: loop {
                tokio::select! {
                    biased;
                    _ = pump_control.wait_for_close() => {
                        local_close = true;
                        let _ = channel.eof().await;
                        break;
                    }
                    changed = disconnected.changed(), if connection_signal_open => {
                        connection_signal_open = false;
                        if changed.is_ok() && *disconnected.borrow_and_update() {
                            confirmed_transport_lost = true;
                        }
                    }
                    _ = flush_tick.tick() => {
                        // A shell that has not run the bootstrap yet must not
                        // keep its first prompt hidden behind the echo filter.
                        let released = bootstrap_output_filter
                            .as_mut()
                            .map(|filter| filter.expire_prompt_hold(std::time::Instant::now()))
                            .unwrap_or_default();
                        for bytes in output.push(&released) {
                            if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                local_close = true;
                                break 'pump;
                            }
                        }
                        if let Some(bytes) = output.flush() {
                            if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                local_close = true;
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        let Some(msg) = msg else { break };
                        match msg {
                            ChannelMsg::Data { ref data } => {
                                for bytes in push_shell_output(
                                    &mut output,
                                    &mut bootstrap_output_filter,
                                    data,
                                ) {
                                    if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                        local_close = true;
                                        break 'pump;
                                    }
                                }
                            }
                            // stderr (ext=1) is interleaved into the same stream;
                            // a terminal shows both on one screen.
                            ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                                for bytes in push_shell_output(
                                    &mut output,
                                    &mut bootstrap_output_filter,
                                    data,
                                ) {
                                    if !emit_output(&pump_output_flow, &on_event, bytes).await {
                                        local_close = true;
                                        break 'pump;
                                    }
                                }
                            }
                            ChannelMsg::ExitStatus { exit_status } => {
                                exit_code = Some(exit_status as i32);
                                accepting_input = false;
                            }
                            ChannelMsg::ExitSignal { .. } => {
                                // Killed by a signal rather than a clean exit.
                                exit_code = Some(-1);
                                accepting_input = false;
                            }
                            ChannelMsg::Eof | ChannelMsg::Close => {
                                channel_ended = true;
                                break;
                            }
                            _ => {}
                        }
                    }
                    input = pump_control.next_input(), if accepting_input => {
                        match input {
                            Some(input) => {
                                for chunk in input.bytes.chunks(INPUT_WRITE_CHUNK_BYTES) {
                                    tokio::select! {
                                        biased;
                                        _ = pump_control.wait_for_close() => {
                                            local_close = true;
                                            let _ = channel.eof().await;
                                            break 'pump;
                                        }
                                        result = channel.data(chunk) => {
                                            if result.is_err() {
                                                accepting_input = false;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            None => accepting_input = false,
                        }
                    }
                    changed = resize_rx.changed(), if accepting_input => {
                        if changed.is_err() {
                            accepting_input = false;
                            continue;
                        }
                        let size = *resize_rx.borrow_and_update();
                        if let Some((cols, rows)) = size {
                            tokio::select! {
                                biased;
                                _ = pump_control.wait_for_close() => {
                                    local_close = true;
                                    let _ = channel.eof().await;
                                    break 'pump;
                                }
                                _ = channel.window_change(cols as u32, rows as u32, 0, 0) => {}
                            }
                        }
                    }
                }
            }
            let pump_end = classify_pump_end(
                exit_code,
                local_close || pump_control.is_closed(),
                channel_ended,
                confirmed_transport_lost || *disconnected.borrow() || pump_handle.is_closed(),
            );
            if pump_end == PumpEnd::TransportLost {
                pump_transport_lost.store(true, Ordering::Release);
                let _ = on_event.send(PtyEvent::TransportLost {
                    reason: SSH_TRANSPORT_LOST_REASON.to_string(),
                });
            }

            // Preserve any unmatched bootstrap-filter suffix, but never let
            // its delivery delay the TransportLost control event or block
            // teardown indefinitely while renderer output credit is stalled.
            let mut final_output = Vec::new();
            if let Some(filter) = bootstrap_output_filter.take() {
                final_output.extend(output.push(&filter.finish()));
            }
            if let Some(bytes) = output.flush() {
                final_output.push(bytes);
            }
            let tail_bytes: usize = final_output.iter().map(Vec::len).sum();
            if tail_bytes > 0
                && !bounded_final_flush(&pump_output_flow, SSH_FINAL_OUTPUT_FLUSH_TIMEOUT, async {
                    for bytes in final_output {
                        if !emit_output(&pump_output_flow, &on_event, bytes).await {
                            return false;
                        }
                    }
                    true
                })
                .await
            {
                log::warn!("ssh: dropped {tail_bytes} buffered output bytes during final flush");
            }
            pump_output_flow.close();
            pump_control.request_close();
            let _ = on_event.send(PtyEvent::Exit {
                code: exit_code.unwrap_or(SSH_DISCONNECTED_EXIT_CODE),
            });
        });

        Ok(SshSession {
            handle,
            transport_abort: shared.transport_abort,
            _jump_handle: shared.jump_handle,
            control,
            output_flow,
            transport_lost,
            disconnected: shared.disconnected,
            host: params.host,
            port: params.port,
            user: params.auth.user,
            verified_host_key: shared.verified_host_key,
            logical_session_id: params.session_id,
            identity_file: params.auth.identity_file,
            jump_endpoint: params.jump_endpoint.or(shared.jump_endpoint),
            sftp: shared.sftp,
            reverse_hub: shared.reverse_hub,
        })
    }

    pub fn is_shareable(&self) -> bool {
        !self.is_closed() && !self.transport_lost()
    }

    pub fn matches_transport(
        &self,
        host: &str,
        port: u16,
        user: &str,
        identity_file: Option<&str>,
        jump_endpoint: Option<&(String, u16, String)>,
        exclude_logical_id: Option<&str>,
    ) -> bool {
        if exclude_logical_id.is_some_and(|id| id == self.logical_session_id) {
            return false;
        }
        if !self.host.eq_ignore_ascii_case(host) || self.port != port || self.user != user {
            return false;
        }
        if self.identity_file.as_deref() != identity_file {
            return false;
        }
        match (&self.jump_endpoint, jump_endpoint) {
            (None, None) => true,
            (Some(left), Some(right)) => {
                left.0.eq_ignore_ascii_case(&right.0) && left.1 == right.1 && left.2 == right.2
            }
            _ => false,
        }
    }

    pub fn share_transport(&self) -> Option<SharedSshTransport> {
        if !self.is_shareable() {
            return None;
        }
        Some(SharedSshTransport {
            handle: self.handle.clone(),
            transport_abort: self.transport_abort.clone(),
            jump_handle: self._jump_handle.clone(),
            sftp: self.sftp.clone(),
            transport_lost: self.transport_lost.clone(),
            disconnected: self.disconnected.clone(),
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            verified_host_key: self.verified_host_key.clone(),
            identity_file: self.identity_file.clone(),
            jump_endpoint: self.jump_endpoint.clone(),
            reverse_hub: self.reverse_hub.clone(),
        })
    }

    /// Immutable, non-secret identity used to bind transfer recovery records.
    pub fn transfer_identity(&self) -> (String, String, String) {
        (
            format!("{}:{}", self.host.to_ascii_lowercase(), self.port),
            self.user.clone(),
            self.verified_host_key.clone(),
        )
    }

    /// Get (opening on first use) the SFTP session for this connection. The
    /// SFTP subsystem runs on its own channel, separate from the shell.
    pub async fn sftp(&self) -> Result<std::sync::Arc<russh_sftp::client::SftpSession>, String> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let channel = await_stage(
            "open SFTP channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        // If the subsystem request fails (server has no sftp-server / Subsystem
        // sftp disabled), `channel` is still a plain russh Channel — which has
        // NO Drop-side CLOSE (see the exec() cleanup contract below), so simply
        // returning here would leak the just-opened channel slot on the live
        // connection. Close it explicitly first, mirroring exec(). On success
        // the channel is consumed by into_stream() (whose ChannelStream self-
        // closes on drop), so only the request-failure path needs this.
        if let Err(e) = await_stage(
            "request SFTP subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(e);
        }
        let session = await_stage(
            "initialize SFTP",
            SSH_CHANNEL_SETUP_TIMEOUT,
            russh_sftp::client::SftpSession::new(channel.into_stream()),
        )
        .await?;
        let arc = std::sync::Arc::new(session);
        *guard = Some(arc.clone());
        Ok(arc)
    }

    /// Atomically replace `new_path` with `old_path` through OpenSSH's
    /// posix-rename extension. A dedicated channel lets us inspect negotiated
    /// extensions and avoids remote login-shell and platform-specific `mv`
    /// behavior entirely.
    pub async fn sftp_posix_rename(&self, old_path: &str, new_path: &str) -> Result<(), String> {
        let channel = await_stage(
            "open atomic rename SFTP channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request atomic rename SFTP subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }

        let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
        raw.set_timeout(SSH_CHANNEL_SETUP_TIMEOUT.as_secs());
        let result = async {
            let version = await_stage(
                "initialize atomic rename SFTP",
                SSH_CHANNEL_SETUP_TIMEOUT,
                raw.init(),
            )
            .await?;
            if version
                .extensions
                .get("posix-rename@openssh.com")
                .map(String::as_str)
                != Some("1")
            {
                return Err(
                    "remote SFTP server does not support safe atomic overwrite; upload with a new name"
                        .to_string(),
                );
            }
            let data = encode_posix_rename_request(old_path, new_path)?;
            match await_stage(
                "replace remote upload destination",
                SSH_CHANNEL_SETUP_TIMEOUT,
                raw.extended("posix-rename@openssh.com", data),
            )
            .await?
            {
                russh_sftp::protocol::Packet::Status(status)
                    if status.status_code == russh_sftp::protocol::StatusCode::Ok =>
                {
                    Ok(())
                }
                russh_sftp::protocol::Packet::Status(status) => {
                    Err(format!("atomic remote replacement failed: {}", status.error_message))
                }
                _ => Err("atomic remote replacement returned an unexpected response".into()),
            }
        }
        .await;
        let _ = raw.close_session();
        result
    }

    /// Check overwrite support before streaming bytes so unsupported servers
    /// fail without leaving a remote partial file.
    pub async fn supports_sftp_posix_rename(&self) -> Result<bool, String> {
        self.supports_sftp_extension("posix-rename@openssh.com")
            .await
    }

    /// Check whether a new regular file can be published atomically without
    /// replacing a racing destination.
    pub async fn supports_sftp_hardlink(&self) -> Result<bool, String> {
        self.supports_sftp_extension("hardlink@openssh.com").await
    }

    async fn supports_sftp_extension(&self, extension: &str) -> Result<bool, String> {
        let channel = await_stage(
            "open SFTP capability channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request SFTP capability subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }
        let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
        raw.set_timeout(SSH_CHANNEL_SETUP_TIMEOUT.as_secs());
        let result = await_stage(
            "initialize SFTP capability check",
            SSH_CHANNEL_SETUP_TIMEOUT,
            raw.init(),
        )
        .await
        .map(|version| version.extensions.get(extension).map(String::as_str) == Some("1"));
        let _ = raw.close_session();
        result
    }

    /// Read a remote directory a page at a time, enforcing limits before pages
    /// accumulate into one unbounded high-level `ReadDir`. A dedicated SFTP
    /// channel keeps cleanup local: every success, timeout, protocol error, and
    /// limit rejection explicitly closes both the directory handle and session.
    pub async fn read_dir_bounded(
        &self,
        path: &str,
        max_entries: usize,
        max_name_bytes: usize,
        timeout: Duration,
    ) -> Result<Vec<russh_sftp::protocol::File>, String> {
        use russh_sftp::client::error::Error as SftpError;
        use russh_sftp::protocol::StatusCode;

        let channel = await_stage(
            "open directory SFTP channel",
            SSH_CHANNEL_SETUP_TIMEOUT,
            self.handle.channel_open_session(),
        )
        .await?;
        if let Err(error) = await_stage(
            "request directory SFTP subsystem",
            SSH_CHANNEL_SETUP_TIMEOUT,
            channel.request_subsystem(true, "sftp"),
        )
        .await
        {
            let _ = channel.close().await;
            return Err(error);
        }

        let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
        raw.set_timeout(15);
        if let Err(error) = await_stage(
            "initialize directory SFTP",
            SSH_CHANNEL_SETUP_TIMEOUT,
            raw.init(),
        )
        .await
        {
            let _ = raw.close_session();
            return Err(error);
        }
        let handle = match await_stage(
            "open remote directory",
            SSH_CHANNEL_SETUP_TIMEOUT,
            raw.opendir(path),
        )
        .await
        {
            Ok(handle) => handle.handle,
            Err(error) => {
                let _ = raw.close_session();
                return Err(error);
            }
        };

        let deadline = tokio::time::Instant::now() + timeout;
        let mut files = Vec::new();
        let mut name_bytes = 0usize;
        let result = loop {
            let Some(remaining) = deadline.checked_duration_since(tokio::time::Instant::now())
            else {
                break Err(format!(
                    "read remote directory timed out after {}s",
                    timeout.as_secs()
                ));
            };
            crate::modules::perf_counters::sftp_readdir();
            let page = match tokio::time::timeout(remaining, raw.readdir(handle.clone())).await {
                Ok(Ok(page)) => page,
                Ok(Err(SftpError::Status(status))) if status.status_code == StatusCode::Eof => {
                    break Ok(files);
                }
                Ok(Err(error)) => break Err(format!("read remote directory failed: {error}")),
                Err(_) => {
                    break Err(format!(
                        "read remote directory timed out after {}s",
                        timeout.as_secs()
                    ));
                }
            };

            let mut limit_error = None;
            for file in page.files {
                if files.len() >= max_entries {
                    limit_error = Some(format!("remote directory exceeds {max_entries} entries"));
                    break;
                }
                let Some(next_name_bytes) = name_bytes
                    .checked_add(file.filename.len())
                    .and_then(|value| value.checked_add(file.longname.len()))
                else {
                    limit_error = Some("remote directory name size overflow".to_string());
                    break;
                };
                if next_name_bytes > max_name_bytes {
                    limit_error = Some(format!(
                        "remote directory names exceed {max_name_bytes} bytes"
                    ));
                    break;
                }
                name_bytes = next_name_bytes;
                files.push(file);
            }
            if let Some(error) = limit_error {
                break Err(error);
            }
        };

        let _ = tokio::time::timeout(Duration::from_secs(2), raw.close(handle)).await;
        let _ = raw.close_session();
        result
    }

    // These run on the sync Tauri command thread. Reserving bytes and enqueueing
    // one complete batch happen in one lock, so a rejected paste is all-or-none
    // and no caller blocks on network flow control.
    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.control.try_enqueue(data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.control.resize(cols, rows)
    }

    /// Close is idempotent and independent from Data/Resize backpressure. The
    /// pump observes it with biased priority and can cancel an in-flight write.
    pub fn close(&self) -> Result<(), String> {
        self.output_flow.close();
        self.control.request_close();
        Ok(())
    }

    pub fn acknowledge_output(&self, bytes: usize) {
        self.output_flow.acknowledge(bytes);
    }

    pub fn identity(&self) -> (&str, u16, &str, &str) {
        (&self.host, self.port, &self.user, &self.logical_session_id)
    }

    pub fn is_closed(&self) -> bool {
        self.control.is_closed()
    }

    pub async fn wait_closed(&self) {
        self.control.wait_for_close().await;
    }

    pub fn transport_lost(&self) -> bool {
        self.transport_lost.load(Ordering::Acquire)
    }

    pub fn reverse_forward_hub(&self) -> &ReverseForwardHub {
        &self.reverse_hub
    }

    pub async fn request_tcpip_forward(&self, address: &str, port: u32) -> Result<u32, String> {
        if self.is_closed() {
            return Err("SSH session closed".into());
        }
        tokio::time::timeout(
            Duration::from_secs(10),
            self.handle.tcpip_forward(address.to_string(), port),
        )
        .await
        .map_err(|_| "SSH remote forward request timed out".to_string())?
        .map_err(|error| format!("SSH remote forward rejected: {error}"))
    }

    pub async fn cancel_tcpip_forward(&self, address: &str, port: u32) -> Result<(), String> {
        if self.is_closed() {
            return Ok(());
        }
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            self.handle.cancel_tcpip_forward(address.to_string(), port),
        )
        .await;
        Ok(())
    }

    /// Open the exact RFC 4254 direct-tcpip target through this already
    /// authenticated SSH connection. The caller supplies only a validated
    /// loopback host and port; this API never invokes a remote shell.
    pub async fn probe_direct_tcpip(&self, host: &str, port: u16) -> Result<(), String> {
        crate::modules::ssh::direct_tcpip::probe(self, host, port).await
    }

    pub(crate) async fn probe_direct_tcpip_inner(
        &self,
        host: &str,
        port: u16,
    ) -> Result<(), String> {
        if self.is_closed() {
            return Err("SSH session closed".into());
        }
        let channel = tokio::time::timeout(
            Duration::from_secs(5),
            self.handle
                .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0),
        )
        .await
        .map_err(|_| "SSH port forward probe timed out".to_string())?
        .map_err(|error| format!("SSH port forward target rejected: {error}"))?;
        let _ = channel.close().await;
        Ok(())
    }

    /// Bridge one accepted local loopback socket to the exact caller-validated
    /// remote target over a dedicated direct-tcpip channel.
    pub async fn forward_loopback_stream(
        &self,
        stream: tokio::net::TcpStream,
        host: &str,
        port: u16,
    ) -> Result<(), String> {
        let (cancel, cancelled) = watch::channel(false);
        let result =
            crate::modules::ssh::direct_tcpip::relay(self, stream, host, port, cancelled).await;
        drop(cancel);
        result
    }

    async fn open_forward_channel(
        &self,
        host: &str,
        port: u16,
        origin: std::net::SocketAddr,
        cancelled: &mut watch::Receiver<bool>,
    ) -> Result<ForwardChannel, String> {
        let handle = self.handle.clone();
        let host = host.to_string();
        let open = async move {
            handle
                .channel_open_direct_tcpip(
                    host,
                    u32::from(port),
                    origin.ip().to_string(),
                    u32::from(origin.port()),
                )
                .await
                .map(ForwardChannel::new)
                .map_err(|error| format!("SSH port forward channel failed: {error}"))
        };
        await_pending_forward_open(open, cancelled, self.wait_closed(), Duration::from_secs(5))
            .await
    }

    pub(crate) async fn forward_loopback_stream_inner(
        &self,
        stream: tokio::net::TcpStream,
        host: &str,
        port: u16,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), String> {
        if self.is_closed() || *cancelled.borrow() {
            return Err("SSH session closed".into());
        }
        let origin = stream
            .peer_addr()
            .map_err(|error| format!("local forward peer unavailable: {error}"))?;
        let channel = self
            .open_forward_channel(host, port, origin, &mut cancelled)
            .await?;
        self.relay_direct_tcpip(stream, channel, cancelled).await
    }

    /// Open a dynamic-forward target and acknowledge SOCKS only once the SSH
    /// server has accepted the direct-tcpip channel.
    pub(crate) async fn forward_socks_stream_inner(
        &self,
        mut stream: tokio::net::TcpStream,
        host: &str,
        port: u16,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), String> {
        if self.is_closed() || *cancelled.borrow() {
            let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err("SSH session closed".into());
        }
        let origin = match stream.peer_addr() {
            Ok(origin) => origin,
            Err(error) => {
                let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err(format!("dynamic forward peer unavailable: {error}"));
            }
        };
        let channel = match self
            .open_forward_channel(host, port, origin, &mut cancelled)
            .await
        {
            Ok(channel) => channel,
            Err(error) => {
                let _ = stream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err(error);
            }
        };
        if let Err(error) = stream.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await {
            channel.finish().await;
            return Err(format!("SOCKS success reply failed: {error}"));
        }
        self.relay_direct_tcpip(stream, channel, cancelled).await
    }

    async fn relay_direct_tcpip(
        &self,
        mut stream: tokio::net::TcpStream,
        mut channel: ForwardChannel,
        mut cancelled: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let mut local_closed = false;
        let mut remote_closed = false;
        let mut buffer = vec![0_u8; 64 * 1024];
        let result = loop {
            if direct_tcpip_relay_complete(local_closed, remote_closed) {
                break Ok(());
            }
            tokio::select! {
                biased;
                _ = cancelled.changed() => break Err("local forward cancelled".into()),
                _ = self.wait_closed() => break Err("SSH session closed".into()),
                read = stream.read(&mut buffer), if !local_closed => match read {
                    Ok(0) => {
                        local_closed = true;
                        tokio::select! {
                            biased;
                            _ = cancelled.changed() => break Err("local forward cancelled".into()),
                            _ = self.wait_closed() => break Err("SSH session closed".into()),
                            result = channel.eof() => if let Err(error) = result { break Err(error.to_string()); },
                        }
                    }
                    Ok(count) => tokio::select! {
                        biased;
                        _ = cancelled.changed() => break Err("local forward cancelled".into()),
                        _ = self.wait_closed() => break Err("SSH session closed".into()),
                        result = channel.data(&buffer[..count]) => if let Err(error) = result { break Err(error.to_string()); },
                    },
                    Err(error) => break Err(format!("local forward read failed: {error}")),
                },
                message = channel.wait(), if !remote_closed => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => tokio::select! {
                        biased;
                        _ = cancelled.changed() => break Err("local forward cancelled".into()),
                        _ = self.wait_closed() => break Err("SSH session closed".into()),
                        result = stream.write_all(&data) => if let Err(error) = result { break Err(format!("local forward write failed: {error}")); },
                    },
                    Some(ChannelMsg::Eof) => {
                        remote_closed = true;
                        if let Err(error) = stream.shutdown().await { break Err(format!("local forward half-close failed: {error}")); }
                    }
                    Some(ChannelMsg::Close) | None => break Ok(()),
                    _ => {}
                }
            }
        };
        channel.finish().await;
        let _ = stream.shutdown().await;
        result
    }

    /// Run a one-shot command on the remote host over a fresh exec channel on
    /// this same connection, collect stdout (and interleaved stderr) up to
    /// `max_bytes`, and return it once the channel closes.
    ///
    /// Runs on its own SSH channel, so it never blocks the interactive shell
    /// channel (russh multiplexes channels over one TCP connection). The shell
    /// keeps streaming while an exec is in flight.
    ///
    /// Errors surface as strings; callers (e.g. remote git status) degrade to
    /// a "remote git unavailable" message instead of crashing the session.
    pub async fn exec(&self, command: &str, max_bytes: usize) -> Result<String, String> {
        exec_on(
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            None,
            None,
        )
        .await
    }

    /// Execute a one-shot inspection command that can be stopped when its UI
    /// request is superseded. `exec_on` still owns channel teardown, so
    /// cancellation sends CHANNEL_CLOSE instead of merely dropping the future
    /// and leaving the remote `find`/`grep`/`git diff` process alive.
    pub async fn exec_cancellable(
        &self,
        command: &str,
        max_bytes: usize,
        cancelled: Arc<AtomicBool>,
    ) -> Result<String, String> {
        exec_on(
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            Some(cancelled.as_ref()),
            None,
        )
        .await
    }

    /// Execute a probe where a non-zero status is part of the caller's state
    /// machine rather than a transport failure (for example, Git with no
    /// upstream). All other SSH commands should use `exec`.
    #[cfg(all(test, feature = "benchmark"))]
    pub async fn exec_allow_nonzero(
        &self,
        command: &str,
        max_bytes: usize,
    ) -> Result<String, String> {
        exec_on(
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            true,
            None,
            None,
        )
        .await
    }

    #[cfg(test)]
    pub(crate) async fn exec_with_test_request_hook(
        &self,
        command: &str,
        max_bytes: usize,
        request_accepted: &(dyn Fn() + Sync),
    ) -> Result<String, String> {
        exec_on(
            self.handle.clone(),
            command,
            max_bytes,
            Duration::from_secs(15),
            false,
            None,
            Some(request_accepted),
        )
        .await
    }
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // Signal the pump task to send EOF and stop; dropping the `Handle`
        // (held by this struct) tears down the SSH connection. A polite
        // SSH_MSG_DISCONNECT would need an async context we don't have in
        // Drop — channel EOF + handle drop is sufficient for cleanup. Ignore
        // the result: if the pump is already gone there's nothing to signal.
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{Channel, InvokeResponseBody};
    #[test]
    fn posix_rename_request_preserves_two_exact_wire_paths() {
        let old = "/srv/-tmp/可爱 ' draft.tmp";
        let new = "/srv/-tmp/最终 ' file.txt";
        let encoded = encode_posix_rename_request(old, new).expect("encode request");
        let expected = [
            (old.len() as u32).to_be_bytes().as_slice(),
            old.as_bytes(),
            (new.len() as u32).to_be_bytes().as_slice(),
            new.as_bytes(),
        ]
        .concat();
        assert_eq!(encoded, expected);
    }

    #[test]
    fn pump_end_classification_only_reports_unexpected_transport_loss() {
        assert_eq!(
            classify_pump_end(Some(0), false, true, true),
            PumpEnd::RemoteExit
        );
        assert_eq!(
            classify_pump_end(Some(-1), false, true, true),
            PumpEnd::RemoteExit
        );
        assert_eq!(
            classify_pump_end(None, true, false, true),
            PumpEnd::LocalClose
        );
        assert_eq!(
            classify_pump_end(None, false, true, true),
            PumpEnd::TransportLost
        );
        assert_eq!(
            classify_pump_end(None, false, false, false),
            PumpEnd::ChannelEnded
        );
        assert_eq!(
            classify_pump_end(None, false, false, true),
            PumpEnd::TransportLost
        );
    }

    #[test]
    fn ssh_pty_modes_enable_utf8_input() {
        assert_eq!(SSH_PTY_MODES, [(russh::Pty::IUTF8, 1)]);
    }

    #[test]
    fn direct_tcpip_relay_preserves_both_half_closes() {
        assert!(!direct_tcpip_relay_complete(true, false));
        assert!(!direct_tcpip_relay_complete(false, true));
        assert!(direct_tcpip_relay_complete(true, true));
    }

    #[test]
    fn transport_lost_event_has_a_stable_camel_case_contract() {
        let json = serde_json::to_value(PtyEvent::TransportLost {
            reason: SSH_TRANSPORT_LOST_REASON.to_string(),
        })
        .expect("serialize transport-lost event");
        assert_eq!(json["type"], "transportLost");
        assert_eq!(json["reason"], "transportClosed");
    }

    #[tokio::test]
    async fn bounded_final_flush_times_out_and_closes_output_flow() {
        let flow = OutputFlow::new();
        assert!(
            !bounded_final_flush(
                &flow,
                Duration::from_millis(1),
                std::future::pending::<bool>(),
            )
            .await
        );
        assert!(!flow.reserve(1).await, "closed flow must reject new output");
    }

    #[tokio::test]
    async fn bounded_final_flush_preserves_a_completed_flush() {
        let flow = OutputFlow::new();
        assert!(bounded_final_flush(&flow, Duration::from_secs(1), async { true }).await);
        assert!(flow.reserve(1).await, "successful flush leaves flow usable");
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and a working SSH agent"]
    async fn real_ssh_control_and_output_batch_smoke() {
        let host = std::env::var("TUNARA_SSH_SMOKE_HOST")
            .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
        let user = std::env::var("TUNARA_SSH_SMOKE_USER").unwrap_or_else(|_| "root".into());
        let port = std::env::var("TUNARA_SSH_SMOKE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let on_event = Channel::<PtyEvent>::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let session = tokio::time::timeout(
            Duration::from_secs(30),
            SshSession::open(
                ConnectParams {
                    host,
                    port,
                    auth: AuthOptions {
                        user,
                        method: crate::modules::ssh::auth::AuthMethod::Agent,
                        identity_file: None,
                        certificate_file: None,
                        key_passphrase: None,
                        password: None,
                    },
                    policy: HostKeyPolicy::AcceptUnknown,
                    cols: 80,
                    rows: 24,
                    initial_cwd: None,
                    inject_shell_integration: false,
                    session_id: "m1-real-smoke".into(),
                    transport_generation: "smoke".into(),
                    hop_role: "direct".into(),
                    jump_endpoint: None,
                },
                on_event,
            ),
        )
        .await
        .expect("SSH open timeout")
        .expect("SSH open");

        session.resize(90, 30).expect("first resize");
        session.resize(132, 43).expect("latest resize");
        let marker = "__TUNARA_M1_REAL_SSH_OK__";
        session
            .write(
                format!("head -c 131072 /dev/zero | tr '\\0' x; printf '\\n{marker}\\n'\n")
                    .as_bytes(),
            )
            .expect("write output fixture");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut output = Vec::new();
        let started = tokio::time::Instant::now();
        let mut data_events = 0usize;
        let completed = |bytes: &[u8]| {
            bytes
                .windows(marker.len())
                .enumerate()
                .any(|(offset, candidate)| {
                    candidate == marker.as_bytes()
                        && bytes[..offset].iter().filter(|byte| **byte == b'x').count() >= 131_072
                })
        };
        while !completed(&output) {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .expect("marker before deadline");
            let body = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect("SSH event timeout")
                .expect("SSH event channel open");
            let InvokeResponseBody::Json(json) = body else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(&json).expect("valid event JSON");
            if event.get("type").and_then(serde_json::Value::as_str) == Some("data") {
                data_events += 1;
                let encoded = event
                    .get("data")
                    .and_then(serde_json::Value::as_str)
                    .expect("data payload");
                output.extend(B64.decode(encoded).expect("base64 output"));
            }
        }
        assert!(completed(&output), "large output must arrive before marker");
        eprintln!(
            "real SSH smoke: {} output bytes in {} Data events over {} ms",
            output.len(),
            data_events,
            started.elapsed().as_millis()
        );

        session.close().expect("first close");
        session.close().expect("idempotent close");
        let exit_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = exit_deadline
                .checked_duration_since(tokio::time::Instant::now())
                .expect("Exit before deadline");
            let body = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect("Exit timeout")
                .expect("event channel open");
            let InvokeResponseBody::Json(json) = body else {
                continue;
            };
            let event: serde_json::Value = serde_json::from_str(&json).expect("valid event JSON");
            if event.get("type").and_then(serde_json::Value::as_str) == Some("exit") {
                break;
            }
        }
    }
}
