use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handle;
use russh::ChannelMsg;

use super::host_key::ClientHandler;
use super::transport::await_pending_exec_open;
use super::{await_stage, SSH_CHANNEL_SETUP_TIMEOUT};
fn exec_status_error(
    exit_status: Option<u32>,
    exit_signal: Option<&str>,
    stderr: &[u8],
) -> Option<String> {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if let Some(signal) = exit_signal {
        return Some(if stderr.is_empty() {
            format!("remote command terminated by signal {signal}")
        } else {
            stderr
        });
    }
    match exit_status {
        Some(0) | None => None,
        Some(status) => Some(if stderr.is_empty() {
            format!("remote command exited with status {status}")
        } else {
            stderr
        }),
    }
}

fn stderr_only_is_error(allow_nonzero: bool, exit_status: Option<u32>) -> bool {
    !allow_nonzero || exit_status.is_none() || exit_status == Some(0)
}

/// `SshSession::exec`, as a free function so it can also run during
/// `SshSession::open` (integration staging) before the session is constructed.
pub(crate) async fn exec_on(
    handle: Arc<Handle<ClientHandler>>,
    command: &str,
    max_bytes: usize,
    timeout: Duration,
    allow_nonzero: bool,
    cancelled: Option<&AtomicBool>,
    request_accepted: Option<&(dyn Fn() + Sync)>,
) -> Result<String, String> {
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        return Err("remote command cancelled".into());
    }
    let mut channel = await_pending_exec_open(handle, cancelled).await?;
    crate::modules::perf_counters::ssh_exec_channel();
    if cancelled.is_some_and(|token| token.load(Ordering::Acquire)) {
        channel.finish().await;
        return Err("remote command cancelled".into());
    }
    if let Err(error) = await_stage(
        "start remote command",
        SSH_CHANNEL_SETUP_TIMEOUT,
        channel.exec(true, command),
    )
    .await
    {
        channel.finish().await;
        return Err(error);
    }
    if let Some(notify) = request_accepted {
        notify();
    }

    let cancellation = wait_for_exec_cancel(cancelled);
    tokio::pin!(cancellation);

    let mut out: Vec<u8> = Vec::new();
    let mut stderr_buf: Vec<u8> = Vec::new();
    let mut exceeded = false;
    let mut timed_out = false;
    let mut was_cancelled = false;
    let mut exit_status: Option<u32> = None;
    let mut exit_signal: Option<String> = None;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            biased;
            _ = &mut cancellation => {
                was_cancelled = true;
                break;
            }
            _ = tokio::time::sleep_until(deadline) => {
                // Break (don't early-return) so we still close the channel
                // below — russh Channel has no Drop-side CLOSE, so dropping
                // it would leave the remote process (e.g. a slow `find /`)
                // running and leak the local channel slot.
                timed_out = true;
                break;
            }
            msg = channel.wait() => {
                let Some(msg) = msg else { break };
                match msg {
                    ChannelMsg::Data { ref data } => {
                        if out.len() + data.len() > max_bytes {
                            // Cap: keep the prefix we already have and stop.
                            let room = max_bytes.saturating_sub(out.len());
                            out.extend_from_slice(&data[..room]);
                            exceeded = true;
                            break;
                        }
                        out.extend_from_slice(data);
                    }
                    ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                        // Capture stderr separately so a git status on a
                        // non-repo dir surfaces a useful error rather than
                        // polluting the parsed stdout.
                        const STDERR_CAP: usize = 4 * 1024;
                        if stderr_buf.len() < STDERR_CAP {
                            let room = STDERR_CAP.saturating_sub(stderr_buf.len());
                            stderr_buf.extend_from_slice(&data[..room.min(data.len())]);
                        }
                    }
                    // ExitStatus may arrive before the final stdout/stderr
                    // packets. Record it and keep draining until EOF/Close.
                    ChannelMsg::ExitStatus { exit_status: status } => {
                        exit_status = Some(status);
                    }
                    ChannelMsg::ExitSignal { signal_name, .. } => {
                        exit_signal = Some(format!("{signal_name:?}"));
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        }
    }

    // Always close the channel before returning. On the timeout and
    // cap-exceeded paths the remote process is still running; close() sends
    // CHANNEL_CLOSE so the remote terminates and the local channel slot is
    // released (russh does not do this on drop). On the clean Eof/Close
    // path it's a harmless no-op. Errors here are non-fatal — the command
    // already produced (or failed to produce) its output.
    channel.finish().await;

    if timed_out {
        return Err(format!("exec timed out ({}s)", timeout.as_secs()));
    }
    if was_cancelled {
        return Err("remote command cancelled".into());
    }

    if !allow_nonzero {
        if let Some(error) = exec_status_error(exit_status, exit_signal.as_deref(), &stderr_buf) {
            return Err(error);
        }
    }

    // If we have no stdout but stderr produced something, return stderr so
    // the caller gets a descriptive error (e.g. "fatal: not a git
    // repository"). Trim to keep the toast/message readable.
    if out.is_empty() && !stderr_buf.is_empty() && stderr_only_is_error(allow_nonzero, exit_status)
    {
        let msg = String::from_utf8_lossy(&stderr_buf).trim().to_string();
        return Err(if msg.is_empty() {
            "remote command produced no output".into()
        } else {
            msg
        });
    }

    if exceeded {
        // Hard-cap the output. NOTE: callers can't currently tell truncation
        // from a complete result — `out` carries no marker. Callers that
        // care (remote search) cap well below max_bytes; a marker/flag is a
        // separate contract change, not done here.
        out.truncate(max_bytes);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

pub(crate) async fn wait_for_exec_cancel(cancelled: Option<&AtomicBool>) {
    let Some(cancelled) = cancelled else {
        std::future::pending::<()>().await;
        return;
    };
    while !cancelled.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn exec_cancellation_waiter_resolves_only_after_token_flips() {
        let cancelled = AtomicBool::new(false);
        let waiter = wait_for_exec_cancel(Some(&cancelled));
        tokio::pin!(waiter);

        assert!(tokio::time::timeout(Duration::from_millis(5), &mut waiter)
            .await
            .is_err());
        cancelled.store(true, Ordering::Release);
        tokio::time::timeout(Duration::from_millis(100), &mut waiter)
            .await
            .expect("cancellation waiter should observe the token");
    }

    #[test]
    fn exec_status_is_not_hidden_by_partial_stdout() {
        assert_eq!(
            exec_status_error(Some(2), None, b"fatal: broken\n"),
            Some("fatal: broken".to_string())
        );
        assert_eq!(
            exec_status_error(Some(7), None, b""),
            Some("remote command exited with status 7".to_string())
        );
        assert_eq!(exec_status_error(Some(0), None, b"warning"), None);
    }

    #[test]
    fn allow_nonzero_does_not_turn_stderr_back_into_a_transport_error() {
        assert!(!stderr_only_is_error(true, Some(1)));
        assert!(stderr_only_is_error(true, Some(0)));
        assert!(stderr_only_is_error(true, None));
        assert!(stderr_only_is_error(false, Some(1)));
    }
}
