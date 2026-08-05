//! Low-level RFC 4254 direct-tcpip seam shared by preview and user forwarding.

use std::time::Duration;

use russh::client::Handle;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;

use super::connection::{ClientHandler, SshSession};

/// Open one RFC 4254 direct-tcpip channel and expose it as the byte stream for
/// a nested SSH transport. No remote command is executed and the channel owns
/// its CLOSE-on-drop behavior.
pub async fn into_stream(
    handle: &Handle<ClientHandler>,
    host: &str,
    port: u16,
) -> Result<impl AsyncRead + AsyncWrite + Unpin + Send + 'static, String> {
    let channel = tokio::time::timeout(
        Duration::from_secs(15),
        handle.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0),
    )
    .await
    .map_err(|_| "SSH jump direct-tcpip timed out".to_string())?
    .map_err(|error| format!("SSH jump direct-tcpip rejected: {error}"))?;
    Ok(channel.into_stream())
}

pub async fn probe(session: &SshSession, host: &str, port: u16) -> Result<(), String> {
    session.probe_direct_tcpip_inner(host, port).await
}

pub async fn relay(
    session: &SshSession,
    stream: tokio::net::TcpStream,
    host: &str,
    port: u16,
    cancelled: watch::Receiver<bool>,
) -> Result<(), String> {
    session
        .forward_loopback_stream_inner(stream, host, port, cancelled)
        .await
}

pub async fn relay_socks5(
    session: &SshSession,
    stream: tokio::net::TcpStream,
    host: &str,
    port: u16,
    cancelled: watch::Receiver<bool>,
) -> Result<(), String> {
    session
        .forward_socks_stream_inner(stream, host, port, cancelled)
        .await
}
