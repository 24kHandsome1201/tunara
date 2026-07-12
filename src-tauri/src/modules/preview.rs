use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};

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

#[derive(Default)]
pub struct PreviewWindowState(Mutex<HashMap<String, PreviewSource>>);

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
        .build()
        .map_err(|error| error.to_string())?;
    app.state::<PreviewWindowState>()
        .0
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .insert(label.clone(), source);
    let app_for_close = app.clone();
    let label_for_close = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Ok(mut sources) = app_for_close.state::<PreviewWindowState>().0.lock() {
                sources.remove(&label_for_close);
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
        .0
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .get(&label)
        .map(source_label);
    if registered.as_deref() != Some(label.as_str()) {
        return Err("Preview source is not open".into());
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Preview window is unavailable".to_string())?;
    // WKWebView reloads a committed document, while navigate retries an
    // initial load that failed before committing. Calling both keeps Refresh
    // correct in both states; on_navigation still enforces the exact origin.
    window.reload().map_err(|error| error.to_string())?;
    window.navigate(url).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn preview_close(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    validate_source(&source)?;
    let label = source_label(&source);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    app.state::<PreviewWindowState>()
        .0
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
}
