//! Real SSH operation benchmark behind a user-space delayed TCP proxy.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;

use super::auth::AuthOptions;
use super::connection::{ConnectParams, HostKeyPolicy, SshSession};
use crate::modules::pty::PtyEvent;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn spawn_delayed_tcp_proxy(target_host: String, target_port: u16, one_way_delay: Duration) -> u16 {
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};

    fn relay(mut reader: TcpStream, mut writer: TcpStream, delay: Duration) {
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            std::thread::sleep(delay);
            if writer.write_all(&buffer[..count]).is_err() {
                break;
            }
        }
        let _ = writer.shutdown(Shutdown::Write);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind delayed SSH proxy");
    let port = listener.local_addr().expect("proxy address").port();
    std::thread::Builder::new()
        .name("tunara-ssh-delay-proxy".into())
        .spawn(move || {
            let (client, _) = listener.accept().expect("accept delayed SSH client");
            let upstream = TcpStream::connect((target_host.as_str(), target_port))
                .expect("connect delayed SSH upstream");
            client.set_nodelay(true).ok();
            upstream.set_nodelay(true).ok();
            let client_read = client.try_clone().expect("clone proxy client");
            let upstream_read = upstream.try_clone().expect("clone proxy upstream");
            let forward = std::thread::spawn(move || {
                relay(client_read, upstream, one_way_delay);
            });
            relay(upstream_read, client, one_way_delay);
            forward.join().ok();
        })
        .expect("spawn delayed SSH proxy");
    port
}

fn latency_summary(values: &[f64]) -> serde_json::Value {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let nearest = |percentile: f64| {
        let index = ((percentile * sorted.len() as f64).ceil() as usize)
            .saturating_sub(1)
            .min(sorted.len().saturating_sub(1));
        (sorted[index] * 100.0).round() / 100.0
    };
    serde_json::json!({
        "count": sorted.len(),
        "p50Ms": nearest(0.5),
        "p95Ms": nearest(0.95),
        "maxMs": (sorted.last().copied().unwrap_or_default() * 100.0).round() / 100.0,
    })
}

#[tokio::test]
#[ignore = "requires TUNARA_SSH_SMOKE_HOST and a working SSH agent"]
async fn real_ssh_rtt_operations_benchmark() {
    use std::time::Instant;

    let target_host = std::env::var("TUNARA_SSH_SMOKE_HOST")
        .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
    let target_port = std::env::var("TUNARA_SSH_SMOKE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(22);
    let user = std::env::var("TUNARA_SSH_SMOKE_USER").unwrap_or_else(|_| "root".into());
    let cwd = std::env::var("TUNARA_SSH_SMOKE_CWD")
        .unwrap_or_else(|_| "/root/qclaw-wechat-client".into());
    let samples = std::env::var("TUNARA_SSH_RTT_SAMPLES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5usize);
    assert!(samples > 0 && samples <= 10, "sample count must be 1..=10");

    let mut scenarios = Vec::new();
    for rtt_ms in [100u64, 200u64] {
        let mut connect = Vec::new();
        let mut pwd = Vec::new();
        let mut preview = Vec::new();
        let mut grep = Vec::new();
        let mut diff = Vec::new();
        let mut sftp = Vec::new();
        let mut cancel = Vec::new();

        for sample in 0..samples {
            let proxy_port = spawn_delayed_tcp_proxy(
                target_host.clone(),
                target_port,
                Duration::from_millis(rtt_ms / 2),
            );
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            let on_event = Channel::<PtyEvent>::new(move |body| {
                let _ = tx.send(body);
                Ok(())
            });
            let started = Instant::now();
            let session = tokio::time::timeout(
                Duration::from_secs(60),
                SshSession::open(
                    ConnectParams {
                        host: "127.0.0.1".into(),
                        port: proxy_port,
                        auth: AuthOptions {
                            user: user.clone(),
                            method: crate::modules::ssh::auth::AuthMethod::Agent,
                            identity_file: None,
                            key_passphrase: None,
                            password: None,
                        },
                        policy: HostKeyPolicy::AcceptForTest,
                        cols: 80,
                        rows: 24,
                        initial_cwd: None,
                        inject_shell_integration: false,
                        session_id: format!("m1-rtt-{rtt_ms}-{sample}"),
                    },
                    on_event,
                ),
            )
            .await
            .expect("delayed SSH open timeout")
            .expect("delayed SSH open");
            connect.push(started.elapsed().as_secs_f64() * 1000.0);

            let started = Instant::now();
            assert!(!session
                .exec("pwd", 4096)
                .await
                .expect("remote pwd")
                .is_empty());
            pwd.push(started.elapsed().as_secs_f64() * 1000.0);

            let started = Instant::now();
            let preview_output = session
                .exec(
                    "head -c 4096 /etc/services 2>/dev/null || head -c 4096 /etc/passwd",
                    8192,
                )
                .await
                .expect("remote preview");
            assert!(!preview_output.is_empty());
            preview.push(started.elapsed().as_secs_f64() * 1000.0);

            let started = Instant::now();
            let grep_output = session
                .exec("grep -n root /etc/passwd", 8192)
                .await
                .expect("remote grep");
            assert!(grep_output.contains("root"));
            grep.push(started.elapsed().as_secs_f64() * 1000.0);

            let started = Instant::now();
            let diff_command = format!("git -C {} diff --stat --no-ext-diff", shell_quote(&cwd));
            session
                .exec_allow_nonzero(&diff_command, 64 * 1024)
                .await
                .expect("remote diff probe");
            diff.push(started.elapsed().as_secs_f64() * 1000.0);

            let started = Instant::now();
            session
                .read_dir_bounded(&cwd, 10_000, 4 * 1024 * 1024, Duration::from_secs(30))
                .await
                .expect("remote SFTP directory");
            sftp.push(started.elapsed().as_secs_f64() * 1000.0);

            let cancelled = Arc::new(AtomicBool::new(false));
            let cancel_token = cancelled.clone();
            let cancel_after = Duration::from_millis(250);
            tokio::spawn(async move {
                tokio::time::sleep(cancel_after).await;
                cancel_token.store(true, Ordering::Release);
            });
            let started = Instant::now();
            let error = session
                .exec_cancellable("sleep 30", 1024, cancelled)
                .await
                .expect_err("sleep command should be cancelled");
            assert!(error.contains("cancelled"));
            cancel.push(started.elapsed().saturating_sub(cancel_after).as_secs_f64() * 1000.0);

            session.close().expect("close delayed SSH session");
            drop(session);
        }

        scenarios.push(serde_json::json!({
            "configuredRttMs": rtt_ms,
            "samples": samples,
            "connect": latency_summary(&connect),
            "pwd": latency_summary(&pwd),
            "preview4KiB": latency_summary(&preview),
            "grep": latency_summary(&grep),
            "diffStat": latency_summary(&diff),
            "sftpReadDir": latency_summary(&sftp),
            "cancelEffective": latency_summary(&cancel),
        }));
    }
    eprintln!(
        "M1_SSH_RTT_RESULT {}",
        serde_json::to_string(&serde_json::json!({
            "benchmark": "m1-ssh-rtt-operations",
            "target": target_host,
            "cwd": cwd,
            "scenarios": scenarios,
        }))
        .expect("serialize RTT benchmark")
    );
}
