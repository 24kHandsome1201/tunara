use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AgentHookEvent {
    pub event: String,
    pub session: String,
    pub agent: Option<String>,
    pub code: Option<i32>,
    /// The agent's own session id (e.g. Claude Code's UUID), captured from the
    /// hook payload's stdin. Used to resume the exact prior conversation instead
    /// of scraping the typed command. Absent for events not carrying one.
    #[serde(rename = "agentSessionId", skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[cfg(unix)]
mod platform {
    use super::AgentHookEvent;
    use serde::Deserialize;
    use std::fs;
    use std::io::Read;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use tauri::{AppHandle, Emitter};

    /// Lifecycle hook helper script, written into the private runtime dir at
    /// startup. Agents reference it from their injected --settings file; it reads
    /// the hook payload on stdin, extracts the agent's real session_id, and
    /// relays it to the host socket as `agent_session_id`.
    const AGENT_HOOK_SH: &str = include_str!("scripts/agent-hook.sh");

    pub(super) const AGENT_HOOK_HELPER_NAME: &str = "agent-hook.sh";

    #[derive(Debug, Deserialize)]
    struct HookPayload {
        event: String,
        session: String,
        agent: Option<String>,
        code: Option<i32>,
        #[serde(default)]
        agent_session_id: Option<String>,
    }

    /// Writes (or refreshes) the stable hook helper into the private runtime dir.
    /// Best-effort: a failure only means resume falls back to command scraping.
    fn write_agent_hook_helper(dir: &Path) {
        let path = dir.join(AGENT_HOOK_HELPER_NAME);
        if let Err(e) = fs::write(&path, AGENT_HOOK_SH) {
            log::warn!("agent hook helper write {} failed: {e}", path.display());
            return;
        }
        // Read+exec for the owner only; the dir is already 0700.
        if let Err(e) = fs::set_permissions(&path, fs::Permissions::from_mode(0o500)) {
            log::warn!("agent hook helper chmod {} failed: {e}", path.display());
        }
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

        pub fn agent_config_dir(&self) -> Option<&Path> {
            self.sock_path.parent()
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
        let sock_dir = match hooks_runtime_dir() {
            Ok(dir) => dir,
            Err(e) => {
                log::error!("hooks listener disabled, runtime dir unavailable: {e}");
                return HookListenerState::disabled();
            }
        };
        if let Err(e) = ensure_private_dir(&sock_dir) {
            log::error!("hooks listener disabled, insecure runtime dir: {e}");
            return HookListenerState::disabled();
        }
        prune_stale_hook_sockets(&sock_dir);
        write_agent_hook_helper(&sock_dir);
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
            .name("tunara-hooks-listener".into())
            .spawn(move || {
                log::info!("hooks listener started on {}", sock_path_t.display());
                for stream in listener.incoming() {
                    if shutdown_t.load(Ordering::Acquire) {
                        break;
                    }
                    match stream {
                        Ok(conn) => {
                            // The accept loop is single-threaded and
                            // read_to_string blocks until the peer closes its
                            // write side. A client that connects and then hangs
                            // (a stuck hook script, a stray `nc`) would stall
                            // ALL hook processing forever. Payloads are tiny
                            // one-shot writes, so a short deadline is generous;
                            // a slow/hung writer is dropped and the loop moves
                            // on to the next connection.
                            let _ = conn
                                .set_read_timeout(Some(std::time::Duration::from_secs(2)));
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
                                                agent_session_id: payload
                                                    .agent_session_id
                                                    .filter(|s| !s.is_empty()),
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
                let _ = fs::remove_file(&sock_path_t);
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

    fn hooks_runtime_dir() -> Result<PathBuf, String> {
        if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
            let dir = PathBuf::from(runtime_dir);
            if dir.is_absolute() {
                return Ok(dir.join("tunara"));
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            return Ok(PathBuf::from(home)
                .join(".cache")
                .join("tunara")
                .join("runtime"));
        }
        Err("neither XDG_RUNTIME_DIR nor HOME is set".to_string())
    }

    fn ensure_private_dir(path: &Path) -> Result<(), String> {
        fs::create_dir_all(path).map_err(|e| format!("create {}: {e}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod 0700 {}: {e}", path.display()))?;
        let link_meta =
            fs::symlink_metadata(path).map_err(|e| format!("lstat {}: {e}", path.display()))?;
        if link_meta.file_type().is_symlink() {
            return Err(format!("{} must not be a symlink", path.display()));
        }
        let meta = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
        if !meta.is_dir() {
            return Err(format!("{} is not a directory", path.display()));
        }
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!("{} mode {mode:o} is not private", path.display()));
        }
        Ok(())
    }

    pub(super) fn prune_stale_hook_sockets(sock_dir: &Path) {
        let entries = match fs::read_dir(sock_dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with("hooks-") || !name.ends_with(".sock") {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_socket() {
                continue;
            }

            let path = entry.path();
            if UnixStream::connect(&path).is_err() {
                let _ = fs::remove_file(path);
            }
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

        pub fn agent_config_dir(&self) -> Option<&std::path::Path> {
            None
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
        assert!(state.agent_config_dir().is_none());
        state.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn hook_runtime_prunes_only_stale_tunara_sockets() {
        use std::fs;
        use std::os::unix::net::UnixListener;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::path::PathBuf::from(format!(
            "/tmp/tunara-hook-prune-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();

        let stale_path = dir.join("hooks-stale.sock");
        let stale_listener = UnixListener::bind(&stale_path).unwrap();
        drop(stale_listener);

        let active_path = dir.join("hooks-active.sock");
        let _active_listener = UnixListener::bind(&active_path).unwrap();

        let other_socket_path = dir.join("other.sock");
        let other_listener = UnixListener::bind(&other_socket_path).unwrap();
        drop(other_listener);

        let regular_path = dir.join("hooks-regular.sock");
        fs::write(&regular_path, b"not a socket").unwrap();

        super::platform::prune_stale_hook_sockets(&dir);

        assert!(!stale_path.exists());
        assert!(active_path.exists());
        assert!(other_socket_path.exists());
        assert!(regular_path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hookable_agent_wrappers_match_cli_settings_support() {
        const ZSHRC: &str = include_str!("../pty/scripts/zshrc.zsh");
        const BASHRC: &str = include_str!("../pty/scripts/bashrc.bash");

        for script in [ZSHRC, BASHRC] {
            assert!(script.contains("claude() { _tunara_agent_run claude"));
            assert!(script.contains("droid() { _tunara_agent_run droid"));
            assert!(script.contains("codex() { _tunara_agent_plain_run codex"));
            assert!(!script.contains("codex() { _tunara_agent_run codex"));
            assert!(!script.contains("devin() { _tunara_agent_run devin"));
            assert!(script.contains("_tunara_agent_emit start"));
            assert!(script.contains("_tunara_agent_emit exit"));
        }
    }
}
