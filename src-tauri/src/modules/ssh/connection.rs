// A live SSH connection: one russh `Handle` multiplexing channels.
//
// Phase 1 uses a single interactive shell channel bridged to xterm.js through
// the SAME `PtyEvent` + base64 path the local PTY uses, so the frontend can't
// tell local from remote. The `Handle` is kept alive (later phases open an
// SFTP channel on the same connection).

use std::fmt::Display;
use std::future::Future;
use std::time::Duration;

const SSH_CHANNEL_SETUP_TIMEOUT: Duration = Duration::from_secs(15);

mod bootstrap;
mod host_key;
mod ops;
mod session;
mod transport;

pub use host_key::{resolve_host_key_prompt, ClientHandler, HostKeyPolicy};
pub use session::{ConnectParams, SharedSshTransport, SshSession};
pub use transport::RoutedOpenError;
pub(super) async fn await_stage<T, E, F>(
    label: &str,
    timeout: Duration,
    future: F,
) -> Result<T, String>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("{label} timed out after {}s", timeout.as_secs()))?
        .map_err(|e| format!("{label} failed: {e}"))
}

#[cfg(test)]
mod tests;
