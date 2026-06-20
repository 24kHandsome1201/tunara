use std::io::Read;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
struct HookPayload {
    event: String,
    session: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentHookEvent {
    pub event: String,
    pub session: String,
}

pub struct HookListenerState {
    sock_path: PathBuf,
    shutdown: Arc<AtomicBool>,
}

impl HookListenerState {
    pub fn sock_path(&self) -> &str {
        self.sock_path.to_str().unwrap_or("")
    }

    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = std::os::unix::net::UnixStream::connect(&self.sock_path);
        let _ = std::fs::remove_file(&self.sock_path);
    }
}

pub fn start_listener(app: AppHandle) -> HookListenerState {
    let sock_path = PathBuf::from(format!(
        "/tmp/conduit-hooks-{}.sock",
        std::process::id()
    ));

    let _ = std::fs::remove_file(&sock_path);

    let listener = UnixListener::bind(&sock_path).expect("bind conduit hooks socket");
    listener
        .set_nonblocking(false)
        .expect("set socket blocking");

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_t = shutdown.clone();
    let sock_path_t = sock_path.clone();

    thread::Builder::new()
        .name("conduit-hooks-listener".into())
        .spawn(move || {
            log::info!("hooks listener started on {}", sock_path_t.display());
            for stream in listener.incoming() {
                if shutdown_t.load(Ordering::Acquire) {
                    break;
                }
                match stream {
                    Ok(mut conn) => {
                        let mut buf = vec![0u8; 4096];
                        match conn.read(&mut buf) {
                            Ok(n) if n > 0 => {
                                let raw = String::from_utf8_lossy(&buf[..n]);
                                match serde_json::from_str::<HookPayload>(&raw) {
                                    Ok(payload) => {
                                        log::info!(
                                            "hook event: {} session={}",
                                            payload.event,
                                            payload.session
                                        );
                                        let _ = app.emit(
                                            "agent-hook",
                                            AgentHookEvent {
                                                event: payload.event,
                                                session: payload.session,
                                            },
                                        );
                                    }
                                    Err(e) => {
                                        log::debug!("hooks: invalid JSON: {e} raw={raw}");
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        if shutdown_t.load(Ordering::Acquire) {
                            break;
                        }
                        log::debug!("hooks listener accept error: {e}");
                    }
                }
            }
            log::info!("hooks listener stopped");
        })
        .expect("spawn hooks listener thread");

    HookListenerState {
        sock_path,
        shutdown,
    }
}
