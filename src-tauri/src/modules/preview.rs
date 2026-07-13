use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{TcpStream, ToSocketAddrs},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

const LOAD_FAILURE_TIMEOUT: Duration = Duration::from_secs(8);
const LOOPBACK_CONNECT_TIMEOUT: Duration = Duration::from_millis(350);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSource {
    repository_id: String,
    worktree_id: String,
    workspace_id: String,
    session_id: String,
    terminal_id: String,
    source_url: String,
    transport: String,
    workspace_resolution: String,
    permission: String,
    state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AllowedOrigin {
    scheme: String,
    host: String,
    port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewRuntimeStatus {
    Opening,
    Loading,
    Ready,
    Failed,
}

#[derive(Debug, Clone)]
struct PreviewRuntimeEntry {
    source: PreviewSource,
    status: PreviewRuntimeStatus,
    window_generation: u64,
    load_attempt: u64,
    loading_url: Option<String>,
}

#[derive(Default)]
pub struct PreviewWindowState {
    entries: Mutex<HashMap<String, PreviewRuntimeEntry>>,
    next_window_generation: Mutex<u64>,
}

impl PreviewWindowState {
    fn next_generation(&self) -> Result<u64, String> {
        let mut generation = self
            .next_window_generation
            .lock()
            .map_err(|_| "Preview generation lock poisoned".to_string())?;
        *generation = generation.saturating_add(1);
        Ok(*generation)
    }
}

fn allowed_origin(url: &tauri::Url) -> Result<AllowedOrigin, String> {
    if url.username() != "" || url.password().is_some() {
        return Err("Preview does not accept credential URLs".into());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Preview only accepts HTTP(S) loopback URLs".into());
    }
    let host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Preview URL has no host".to_string())?;
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err("Preview only accepts exact loopback hosts".into());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Preview URL has no valid port".to_string())?;
    Ok(AllowedOrigin {
        scheme: url.scheme().into(),
        host,
        port,
    })
}

fn navigation_allowed(origin: &AllowedOrigin, target: &tauri::Url) -> bool {
    allowed_origin(target).is_ok_and(|candidate| candidate == *origin)
}

fn source_reachable(url: &tauri::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let Some(port) = url.port_or_known_default() else {
        return false;
    };
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, LOOPBACK_CONNECT_TIMEOUT).is_ok())
}

fn validate_source(source: &PreviewSource) -> Result<(tauri::Url, AllowedOrigin), String> {
    if source.transport != "local"
        || source.permission != "eligible"
        || source.state != "active"
        || source.workspace_resolution != "resolved"
    {
        return Err("Preview requires an active, resolved, eligible local source".into());
    }
    if source.repository_id.is_empty()
        || source.worktree_id.is_empty()
        || source.session_id.is_empty()
        || source.terminal_id.is_empty()
        || source.workspace_id != format!("{}::{}", source.repository_id, source.worktree_id)
        || !source
            .terminal_id
            .starts_with(&format!("{}:", source.session_id))
    {
        return Err("Preview source identity is incomplete or inconsistent".into());
    }
    let url = source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "Preview URL is invalid".to_string())?;
    let origin = allowed_origin(&url)?;
    Ok((url, origin))
}

fn validate_source_identity(source: &PreviewSource) -> Result<(), String> {
    if source.repository_id.is_empty()
        || source.worktree_id.is_empty()
        || source.session_id.is_empty()
        || source.terminal_id.is_empty()
        || source.workspace_id != format!("{}::{}", source.repository_id, source.worktree_id)
        || !source
            .terminal_id
            .starts_with(&format!("{}:", source.session_id))
    {
        return Err("Preview source identity is incomplete or inconsistent".into());
    }
    let url = source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "Preview URL is invalid".to_string())?;
    allowed_origin(&url)?;
    Ok(())
}

fn source_label(source: &PreviewSource) -> String {
    let mut hasher = Sha256::new();
    for value in [
        &source.repository_id,
        &source.worktree_id,
        &source.workspace_id,
        &source.session_id,
        &source.terminal_id,
        &source.source_url,
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    format!("preview-{:x}", hasher.finalize())[..32].to_string()
}

#[tauri::command]
pub fn preview_open(app: AppHandle, source: PreviewSource) -> Result<String, String> {
    let (url, origin) = validate_source(&source)?;
    let initially_reachable = source_reachable(&url);
    let label = source_label(&source);
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(label);
    }

    let title = format!(
        "Preview · repo={} · worktree={} · session={} · terminal={} · {}",
        source.repository_id,
        source.worktree_id,
        source.session_id,
        source.terminal_id,
        source.source_url
    );
    let window_generation = app.state::<PreviewWindowState>().next_generation()?;
    app.state::<PreviewWindowState>()
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .insert(
            label.clone(),
            PreviewRuntimeEntry {
                source: source.clone(),
                status: PreviewRuntimeStatus::Opening,
                window_generation,
                load_attempt: 0,
                loading_url: None,
            },
        );
    let app_for_open_timeout = app.clone();
    let label_for_open_timeout = label.clone();
    thread::spawn(move || {
        thread::sleep(LOAD_FAILURE_TIMEOUT);
        let state = app_for_open_timeout.state::<PreviewWindowState>();
        if let Ok(mut entries) = state.entries.lock() {
            if let Some(entry) = entries.get_mut(&label_for_open_timeout) {
                if entry.window_generation == window_generation
                    && entry.load_attempt == 0
                    && entry.status == PreviewRuntimeStatus::Opening
                {
                    entry.status = PreviewRuntimeStatus::Failed;
                }
            }
        };
    });
    let app_for_load = app.clone();
    let label_for_load = label.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(title)
        .inner_size(980.0, 720.0)
        .min_inner_size(480.0, 320.0)
        .on_navigation(move |target| navigation_allowed(&origin, target))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                log::warn!("blocked Preview download: {url}");
            }
            false
        })
        .on_page_load(move |_, payload| match payload.event() {
            PageLoadEvent::Started => {
                let attempt = {
                    let state = app_for_load.state::<PreviewWindowState>();
                    let Ok(mut entries) = state.entries.lock() else {
                        return;
                    };
                    let Some(entry) = entries.get_mut(&label_for_load) else {
                        return;
                    };
                    if entry.window_generation != window_generation {
                        return;
                    }
                    if entry.status == PreviewRuntimeStatus::Failed {
                        return;
                    }
                    entry.load_attempt = entry.load_attempt.saturating_add(1);
                    entry.status = PreviewRuntimeStatus::Loading;
                    entry.loading_url = Some(payload.url().to_string());
                    entry.load_attempt
                };
                let app_for_timeout = app_for_load.clone();
                let label_for_timeout = label_for_load.clone();
                thread::spawn(move || {
                    thread::sleep(LOAD_FAILURE_TIMEOUT);
                    let state = app_for_timeout.state::<PreviewWindowState>();
                    if let Ok(mut entries) = state.entries.lock() {
                        if let Some(entry) = entries.get_mut(&label_for_timeout) {
                            if entry.window_generation == window_generation
                                && entry.load_attempt == attempt
                                && entry.status == PreviewRuntimeStatus::Loading
                            {
                                entry.status = PreviewRuntimeStatus::Failed;
                            }
                        }
                    };
                });
            }
            PageLoadEvent::Finished => {
                let state = app_for_load.state::<PreviewWindowState>();
                if let Ok(mut entries) = state.entries.lock() {
                    if let Some(entry) = entries.get_mut(&label_for_load) {
                        if entry.window_generation == window_generation
                            && entry.status == PreviewRuntimeStatus::Loading
                            && entry.loading_url.as_deref() == Some(payload.url().as_str())
                        {
                            entry.status = PreviewRuntimeStatus::Ready;
                        }
                    }
                };
            }
        })
        .build()
        .map_err(|error| {
            if let Ok(mut entries) = app.state::<PreviewWindowState>().entries.lock() {
                if entries
                    .get(&label)
                    .is_some_and(|entry| entry.window_generation == window_generation)
                {
                    entries.remove(&label);
                }
            }
            error.to_string()
        })?;
    if !initially_reachable {
        if let Ok(mut entries) = app.state::<PreviewWindowState>().entries.lock() {
            if let Some(entry) = entries.get_mut(&label) {
                if entry.window_generation == window_generation {
                    entry.status = PreviewRuntimeStatus::Failed;
                }
            }
        }
    }
    let app_for_close = app.clone();
    let label_for_close = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut entries) = app_for_close.state::<PreviewWindowState>().entries.lock() {
                if entries
                    .get(&label_for_close)
                    .is_some_and(|entry| entry.window_generation == window_generation)
                {
                    entries.remove(&label_for_close);
                }
            }
        }
    });
    Ok(label)
}

#[tauri::command]
pub fn preview_refresh(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    let (url, _) = validate_source(&source)?;
    let label = source_label(&source);
    let state = app.state::<PreviewWindowState>();
    let registered = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .get(&label)
        .map(|entry| source_label(&entry.source));
    if registered.as_deref() != Some(label.as_str()) {
        return Err("Preview source is not open".into());
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Preview window is unavailable".to_string())?;
    if !source_reachable(&url) {
        if let Ok(mut entries) = state.entries.lock() {
            if let Some(entry) = entries.get_mut(&label) {
                entry.status = PreviewRuntimeStatus::Failed;
            }
        }
        return Ok(());
    }
    let (status, window_generation, attempt) = {
        let mut entries = state
            .entries
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        let entry = entries
            .get_mut(&label)
            .ok_or_else(|| "Preview source is not open".to_string())?;
        let status = entry.status;
        if matches!(
            status,
            PreviewRuntimeStatus::Ready | PreviewRuntimeStatus::Failed
        ) {
            entry.load_attempt = entry.load_attempt.saturating_add(1);
            entry.status = PreviewRuntimeStatus::Loading;
            entry.loading_url = Some(url.to_string());
        }
        (status, entry.window_generation, entry.load_attempt)
    };
    if matches!(
        status,
        PreviewRuntimeStatus::Ready | PreviewRuntimeStatus::Failed
    ) {
        let app_for_timeout = app.clone();
        let label_for_timeout = label.clone();
        thread::spawn(move || {
            thread::sleep(LOAD_FAILURE_TIMEOUT);
            let state = app_for_timeout.state::<PreviewWindowState>();
            if let Ok(mut entries) = state.entries.lock() {
                if let Some(entry) = entries.get_mut(&label_for_timeout) {
                    if entry.window_generation == window_generation
                        && entry.load_attempt == attempt
                        && entry.status == PreviewRuntimeStatus::Loading
                    {
                        entry.status = PreviewRuntimeStatus::Failed;
                    }
                }
            };
        });
    }
    let result = match status {
        PreviewRuntimeStatus::Failed => window.navigate(url).map_err(|error| error.to_string()),
        PreviewRuntimeStatus::Ready => window.reload().map_err(|error| error.to_string()),
        PreviewRuntimeStatus::Opening | PreviewRuntimeStatus::Loading => {
            Err("Preview is already loading".into())
        }
    };
    if result.is_err() {
        if let Ok(mut entries) = state.entries.lock() {
            if let Some(entry) = entries.get_mut(&label) {
                if entry.window_generation == window_generation {
                    entry.status = PreviewRuntimeStatus::Failed;
                }
            }
        }
    }
    result
}

#[tauri::command]
pub fn preview_status(
    app: AppHandle,
    source: PreviewSource,
) -> Result<Option<PreviewRuntimeStatus>, String> {
    validate_source_identity(&source)?;
    let label = source_label(&source);
    let state = app.state::<PreviewWindowState>();
    let entries = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;
    Ok(entries.get(&label).map(|entry| entry.status))
}

#[tauri::command]
pub fn preview_close(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    validate_source_identity(&source)?;
    let label = source_label(&source);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    app.state::<PreviewWindowState>()
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .remove(&label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(url: &str) -> PreviewSource {
        PreviewSource {
            repository_id: "repo-a".into(),
            worktree_id: "worktree-a".into(),
            workspace_id: "repo-a::worktree-a".into(),
            session_id: "session-a".into(),
            terminal_id: "session-a:0".into(),
            source_url: url.into(),
            transport: "local".into(),
            workspace_resolution: "resolved".into(),
            permission: "eligible".into(),
            state: "active".into(),
        }
    }

    #[test]
    fn accepts_only_exact_source_origin_navigation() {
        let (_, origin) = validate_source(&source("http://127.0.0.1:4173/app")).unwrap();
        assert!(navigation_allowed(
            &origin,
            &"http://127.0.0.1:4173/next".parse().unwrap()
        ));
        assert!(!navigation_allowed(
            &origin,
            &"http://127.0.0.1:5173/".parse().unwrap()
        ));
        assert!(!navigation_allowed(
            &origin,
            &"https://example.com/".parse().unwrap()
        ));
        assert!(!navigation_allowed(
            &origin,
            &"file:///tmp/secret".parse().unwrap()
        ));
    }

    #[test]
    fn rejects_credentials_remote_stale_and_fallback_sources() {
        assert!(validate_source(&source("http://user:pass@localhost:4173/")).is_err());
        let mut remote = source("http://localhost:4173/");
        remote.transport = "ssh".into();
        remote.permission = "remote-manual".into();
        assert!(validate_source(&remote).is_err());
        let mut stale = source("http://localhost:4173/");
        stale.state = "stale".into();
        assert!(validate_source(&stale).is_err());
        let mut fallback = source("http://localhost:4173/");
        fallback.workspace_resolution = "fallback".into();
        assert!(validate_source(&fallback).is_err());
    }

    #[test]
    fn identity_keeps_worktrees_and_terminals_separate() {
        let first = source("http://localhost:4173/");
        let mut second = source("http://localhost:4173/");
        second.worktree_id = "worktree-b".into();
        second.workspace_id = "repo-a::worktree-b".into();
        assert_ne!(source_label(&first), source_label(&second));
        second = first.clone();
        second.terminal_id = "session-a:1".into();
        assert_ne!(source_label(&first), source_label(&second));
    }

    #[test]
    fn stale_identity_can_be_closed_but_never_expands_beyond_loopback() {
        let mut stale = source("http://127.0.0.1:4173/");
        stale.state = "stale".into();
        assert!(validate_source_identity(&stale).is_ok());
        stale.source_url = "https://example.com/".into();
        assert!(validate_source_identity(&stale).is_err());
    }

    #[test]
    fn reachability_checks_only_the_validated_exact_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let url = format!("http://127.0.0.1:{}/", address.port())
            .parse::<tauri::Url>()
            .unwrap();
        assert!(source_reachable(&url));
    }
}
