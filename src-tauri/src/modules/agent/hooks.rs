use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AgentHookEvent {
    pub event: String,
    pub session: String,
    pub agent: Option<String>,
    pub code: Option<i32>,
}

#[cfg(unix)]
mod platform {
    use super::AgentHookEvent;
    use serde::Deserialize;
    use std::fs;
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use tauri::{AppHandle, Emitter};

    #[derive(Debug, Deserialize)]
    struct HookPayload {
        event: String,
        session: String,
        agent: Option<String>,
        code: Option<i32>,
    }

    pub struct HookListenerState {
        sock_path: PathBuf,
        shutdown: Arc<AtomicBool>,
    }

    impl HookListenerState {
        pub(super) fn disabled() -> Self {
            Self {
                sock_path: PathBuf::new(),
                shutdown: Arc::new(AtomicBool::new(false)),
            }
        }

        pub fn sock_path(&self) -> &str {
            self.sock_path.to_str().unwrap_or("")
        }

        pub fn shutdown(&self) {
            if self.sock_path.as_os_str().is_empty() {
                return;
            }
            self.shutdown.store(true, Ordering::Release);
            let _ = UnixStream::connect(&self.sock_path);
            let _ = std::fs::remove_file(&self.sock_path);
        }
    }

    pub fn start_listener(app: AppHandle) -> HookListenerState {
        let sock_dir = std::env::temp_dir().join("conduit-sockets");
        if let Err(e) = fs::create_dir_all(&sock_dir) {
            log::error!("failed to create hooks socket dir: {e}");
            return HookListenerState::disabled();
        }
        #[cfg(unix)]
        {
            if let Err(e) = fs::set_permissions(&sock_dir, fs::Permissions::from_mode(0o700)) {
                log::warn!("failed to restrict hooks socket dir permissions: {e}");
            }
        }
        let sock_path = sock_dir.join(format!("hooks-{}.sock", std::process::id()));

        let _ = fs::remove_file(&sock_path);

        let listener = match UnixListener::bind(&sock_path) {
            Ok(listener) => listener,
            Err(e) => {
                log::error!(
                    "hooks listener disabled, bind {} failed: {e}",
                    sock_path.display()
                );
                return HookListenerState::disabled();
            }
        };
        if let Err(e) = listener.set_nonblocking(false) {
            log::error!("hooks listener disabled, configure blocking mode failed: {e}");
            let _ = fs::remove_file(&sock_path);
            return HookListenerState::disabled();
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_t = shutdown.clone();
        let sock_path_t = sock_path.clone();

        if let Err(e) = thread::Builder::new()
            .name("conduit-hooks-listener".into())
            .spawn(move || {
                log::info!("hooks listener started on {}", sock_path_t.display());
                for stream in listener.incoming() {
                    if shutdown_t.load(Ordering::Acquire) {
                        break;
                    }
                    match stream {
                        Ok(conn) => {
                            let mut raw = String::new();
                            match conn.take(65536).read_to_string(&mut raw) {
                                Ok(n) if n > 0 => match serde_json::from_str::<HookPayload>(&raw) {
                                    Ok(payload) => {
                                        log::info!(
                                            "hook event: {} session={} agent={:?} code={:?}",
                                            payload.event,
                                            payload.session,
                                            payload.agent,
                                            payload.code
                                        );
                                        let _ = app.emit(
                                            "agent-hook",
                                            AgentHookEvent {
                                                event: payload.event,
                                                session: payload.session,
                                                agent: payload.agent,
                                                code: payload.code,
                                            },
                                        );
                                    }
                                    Err(e) => {
                                        log::debug!("hooks: invalid JSON: {e} raw={raw}");
                                    }
                                },
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
        {
            log::error!("hooks listener disabled, thread spawn failed: {e}");
            let _ = fs::remove_file(&sock_path);
            return HookListenerState::disabled();
        }

        HookListenerState {
            sock_path,
            shutdown,
        }
    }
}

#[cfg(not(unix))]
mod platform {
    use tauri::AppHandle;

    pub struct HookListenerState;

    impl HookListenerState {
        pub fn sock_path(&self) -> &str {
            ""
        }

        pub fn shutdown(&self) {}
    }

    pub fn start_listener(_app: AppHandle) -> HookListenerState {
        HookListenerState
    }
}

pub use platform::{start_listener, HookListenerState};

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn disabled_hook_listener_exports_no_socket_path() {
        let state = super::platform::HookListenerState::disabled();

        assert_eq!(state.sock_path(), "");
        state.shutdown();
    }

    #[test]
    fn hookable_agent_wrappers_match_cli_settings_support() {
        const ZSHRC: &str = include_str!("../pty/scripts/zshrc.zsh");
        const BASHRC: &str = include_str!("../pty/scripts/bashrc.bash");

        for script in [ZSHRC, BASHRC] {
            assert!(script.contains("claude() { _conduit_agent_run claude"));
            assert!(script.contains("droid() { _conduit_agent_run droid"));
            assert!(script.contains("codex() { _conduit_agent_plain_run codex"));
            assert!(!script.contains("codex() { _conduit_agent_run codex"));
            assert!(!script.contains("devin() { _conduit_agent_run devin"));
            assert!(script.contains("_conduit_agent_emit start"));
            assert!(script.contains("_conduit_agent_emit exit"));
        }
    }
}
