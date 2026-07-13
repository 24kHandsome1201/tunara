use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::{
    collections::{HashMap, VecDeque},
    net::{TcpStream, ToSocketAddrs},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

const LOAD_FAILURE_TIMEOUT: Duration = Duration::from_secs(8);
const LOOPBACK_CONNECT_TIMEOUT: Duration = Duration::from_millis(350);
const DEFAULT_VIEWPORT: (u32, u32) = (980, 720);
const VIEWPORT_PRESETS: [(u32, u32); 3] = [(390, 844), (768, 1024), (1280, 720)];
const ZOOM_PRESETS: [f64; 6] = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5];
const TELEMETRY_MAX_EVENTS: usize = 32;
const TELEMETRY_MAX_TEXT: usize = 512;
const TELEMETRY_RATE_WINDOW: Duration = Duration::from_secs(10);
const TELEMETRY_MAX_PER_WINDOW: u32 = 40;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSource {
    repository_id: String,
    worktree_id: String,
    workspace_id: String,
    session_id: String,
    terminal_id: String,
    physical_pty_id: Option<u32>,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRuntimeState {
    status: PreviewRuntimeStatus,
    current_url: String,
    can_go_back: bool,
    can_go_forward: bool,
    zoom_factor: f64,
    viewport: PreviewViewportState,
    telemetry: PreviewTelemetrySummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTelemetrySummary {
    generation: u64,
    events: Vec<PreviewTelemetrySummaryEvent>,
    dropped: u32,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTelemetrySummaryEvent {
    kind: String,
    message: String,
    count: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewTelemetryInput {
    kind: String,
    message: Option<String>,
    url: Option<String>,
    method: Option<String>,
    status: Option<u16>,
    phase: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreviewTelemetryEvent {
    kind: String,
    message: String,
    count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewViewportState {
    mode: String,
    requested_width: u32,
    requested_height: u32,
    actual_width: u32,
    actual_height: u32,
    outer_width: u32,
    outer_height: u32,
    exact: bool,
}

#[derive(Debug, Clone)]
struct PreviewRuntimeEntry {
    source: PreviewSource,
    status: PreviewRuntimeStatus,
    window_generation: u64,
    load_attempt: u64,
    loading_url: Option<String>,
    viewport_mode: String,
    requested_viewport: (u32, u32),
    telemetry_nonce: String,
    telemetry: VecDeque<PreviewTelemetryEvent>,
    telemetry_rate_started: Instant,
    telemetry_rate_count: u32,
    telemetry_dropped: u32,
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

fn normalize_address(
    source_url: &tauri::Url,
    current_url: &tauri::Url,
    address: &str,
) -> Result<tauri::Url, String> {
    let address = address.trim();
    if address.is_empty() {
        return Err("Preview address is empty".into());
    }
    let origin = allowed_origin(source_url)?;
    let target = current_url
        .join(address)
        .map_err(|_| "Preview address is invalid".to_string())?;
    if !navigation_allowed(&origin, &target) {
        return Err("Preview address must keep the approved source origin".into());
    }
    Ok(target)
}

#[cfg(target_os = "macos")]
fn native_history(window: &tauri::WebviewWindow) -> Result<(bool, bool), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            let _ = sender.send((view.canGoBack(), view.canGoForward()));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Preview history query timed out".to_string())
}

#[cfg(not(target_os = "macos"))]
fn native_history(_window: &tauri::WebviewWindow) -> Result<(bool, bool), String> {
    Ok((false, false))
}

#[cfg(target_os = "macos")]
fn native_history_move(window: &tauri::WebviewWindow, back: bool) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            let allowed = if back {
                view.canGoBack()
            } else {
                view.canGoForward()
            };
            if allowed {
                if back {
                    view.goBack();
                } else {
                    view.goForward();
                }
            }
            let _ = sender.send(allowed);
        })
        .map_err(|error| error.to_string())?;
    match receiver.recv_timeout(Duration::from_secs(1)) {
        Ok(true) => Ok(()),
        Ok(false) => Err(if back {
            "Preview has no back history"
        } else {
            "Preview has no forward history"
        }
        .into()),
        Err(_) => Err("Preview history action timed out".into()),
    }
}

fn validate_zoom_factor(factor: f64) -> Result<f64, String> {
    if !factor.is_finite() {
        return Err("Preview zoom must be finite".into());
    }
    if !(0.5..=2.0).contains(&factor) {
        return Err("Preview zoom is outside the safe range".into());
    }
    ZOOM_PRESETS
        .iter()
        .copied()
        .find(|preset| (factor - preset).abs() < f64::EPSILON)
        .ok_or_else(|| "Preview zoom must use an approved preset".into())
}

fn validate_viewport(width: u32, height: u32) -> Result<(u32, u32), String> {
    VIEWPORT_PRESETS
        .iter()
        .copied()
        .find(|preset| *preset == (width, height))
        .ok_or_else(|| "Preview viewport must use an approved preset".into())
}

#[cfg(target_os = "macos")]
fn logical_webview_size(window: &tauri::WebviewWindow) -> Result<(u32, u32), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            let frame = view.frame();
            let safe = view.safeAreaInsets();
            let _ = sender.send((
                (frame.size.width - safe.left - safe.right).round() as u32,
                (frame.size.height - safe.top - safe.bottom).round() as u32,
            ));
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Preview viewport query timed out".to_string())
}

#[cfg(not(target_os = "macos"))]
fn logical_webview_size(window: &tauri::WebviewWindow) -> Result<(u32, u32), String> {
    let physical = window.as_ref().size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    Ok((
        (physical.width as f64 / scale).round() as u32,
        (physical.height as f64 / scale).round() as u32,
    ))
}

fn window_chrome_inset(window: &tauri::WebviewWindow) -> Result<(u32, u32), String> {
    let physical = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let window_size = (
        (physical.width as f64 / scale).round() as u32,
        (physical.height as f64 / scale).round() as u32,
    );
    let webview_size = logical_webview_size(window)?;
    Ok((
        window_size.0.saturating_sub(webview_size.0),
        window_size.1.saturating_sub(webview_size.1),
    ))
}

#[cfg(target_os = "macos")]
fn native_zoom(window: &tauri::WebviewWindow) -> Result<f64, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            let _ = sender.send(view.pageZoom());
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Preview zoom query timed out".to_string())
}

#[cfg(not(target_os = "macos"))]
fn native_zoom(_window: &tauri::WebviewWindow) -> Result<f64, String> {
    Ok(1.0)
}

#[cfg(target_os = "macos")]
fn set_native_zoom(window: &tauri::WebviewWindow, factor: f64) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            view.setPageZoom(factor);
            let _ = sender.send(view.pageZoom());
        })
        .map_err(|error| error.to_string())?;
    let actual = receiver
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "Preview zoom action timed out".to_string())?;
    if (actual - factor).abs() > 0.001 {
        return Err("Preview zoom did not reach the requested value".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn set_native_zoom(_window: &tauri::WebviewWindow, _factor: f64) -> Result<(), String> {
    Err("Native Preview zoom is unavailable on this platform".into())
}

#[cfg(not(target_os = "macos"))]
fn native_history_move(_window: &tauri::WebviewWindow, _back: bool) -> Result<(), String> {
    Err("Native Preview history is unavailable on this platform".into())
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

fn safe_source_url(raw: &str) -> String {
    let Ok(mut url) = raw.parse::<tauri::Url>() else {
        return "<invalid-url>".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn sanitize_text(raw: &str) -> String {
    let mut value = raw
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, ' ' | '\t' | '\n' | '\r'))
        .collect::<String>()
        .replace(['\r', '\n', '\t'], " ");
    for marker in [
        "authorization",
        "cookie",
        "set-cookie",
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "username",
        "user",
    ] {
        let mut search_from = 0;
        loop {
            let lower = value.to_ascii_lowercase();
            let Some(relative) = lower[search_from..].find(marker) else {
                break;
            };
            let start = search_from + relative;
            let tail = &value[start + marker.len()..];
            let Some(separator) = tail.find([':', '=']) else {
                search_from = start + marker.len();
                continue;
            };
            if separator > 3 {
                search_from = start + marker.len();
                continue;
            }
            let secret_start = start + marker.len() + separator + 1;
            let secret_end = value[secret_start..]
                .find(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';' | ')' | ']' | '}'))
                .map_or(value.len(), |offset| secret_start + offset);
            value.replace_range(secret_start..secret_end, "<redacted>");
            search_from = secret_start + "<redacted>".len();
        }
    }
    value = value
        .split_whitespace()
        .map(|token| {
            if token.starts_with("http://") || token.starts_with("https://") {
                safe_source_url(token)
            } else if token.starts_with("/Users/")
                || token.starts_with("/home/")
                || token.starts_with("/root/")
                || (token.len() > 3
                    && token.as_bytes()[1] == b':'
                    && matches!(token.as_bytes()[2], b'\\' | b'/'))
            {
                "<path>".into()
            } else if token.len() >= 32
                && token.chars().all(|ch| {
                    ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | '+')
                })
            {
                "<redacted>".into()
            } else {
                token.into()
            }
        })
        .collect::<Vec<String>>()
        .join(" ");
    value.chars().take(TELEMETRY_MAX_TEXT).collect()
}

fn contains_base64_blob(raw: &str) -> bool {
    raw.split_whitespace().any(|token| {
        let token = token.trim_matches(|ch: char| matches!(ch, ',' | ';' | ':' | ')' | ']' | '}'));
        token.len() >= 64
            && token.len() % 4 == 0
            && token
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
    })
}

fn sanitize_event_url(raw: &str, source: &PreviewSource) -> String {
    let Ok(url) = raw.parse::<tauri::Url>() else {
        return "<invalid-url>".into();
    };
    let Ok(source_url) = source.source_url.parse::<tauri::Url>() else {
        return "<invalid-url>".into();
    };
    let path = sanitize_text(url.path());
    if allowed_origin(&url).ok() == allowed_origin(&source_url).ok() {
        if path.is_empty() {
            "/".into()
        } else {
            path
        }
    } else {
        "<external>".into()
    }
}

fn normalize_telemetry_event(
    input: PreviewTelemetryInput,
    source: &PreviewSource,
) -> Result<PreviewTelemetryEvent, String> {
    let message = input.message.as_deref().unwrap_or("");
    if input.kind.len() > 32
        || input
            .method
            .as_ref()
            .is_some_and(|method| method.len() > 16)
        || input.phase.as_ref().is_some_and(|phase| phase.len() > 16)
        || message.len() > TELEMETRY_MAX_TEXT * 2
        || input
            .url
            .as_ref()
            .is_some_and(|url| url.len() > TELEMETRY_MAX_TEXT * 2)
    {
        return Err("Preview telemetry field is too large".into());
    }
    let normalized = match input.kind.as_str() {
        "console-error" | "unhandled-error" => {
            if input.url.is_some()
                || input.method.is_some()
                || input.status.is_some()
                || input.phase.is_some()
            {
                return Err("Preview error telemetry has unexpected fields".into());
            }
            let message = sanitize_text(message);
            if message.is_empty() {
                return Err("Preview error telemetry message is empty".into());
            }
            if contains_base64_blob(&message) {
                return Err("Preview error telemetry contains an encoded blob".into());
            }
            PreviewTelemetryEvent {
                kind: input.kind,
                message,
                count: 1,
            }
        }
        "network-failure" => {
            if input.message.is_some()
                || input.url.as_deref().is_none_or(str::is_empty)
                || input.method.as_deref().is_none_or(str::is_empty)
                || input.phase.as_deref().is_none_or(str::is_empty)
            {
                return Err("Preview network telemetry schema is incomplete".into());
            }
            let method = input
                .method
                .as_deref()
                .expect("network method was checked")
                .to_ascii_uppercase();
            if !matches!(
                method.as_str(),
                "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
            ) {
                return Err("Preview telemetry method is not allowed".into());
            }
            let phase = input.phase.as_deref().expect("network phase was checked");
            if !matches!(phase, "fetch" | "xhr" | "resource" | "request") {
                return Err("Preview telemetry phase is not allowed".into());
            }
            if input
                .status
                .is_some_and(|status| !(300..=599).contains(&status))
            {
                return Err("Preview telemetry status is not a failure status".into());
            }
            let url = sanitize_event_url(
                input.url.as_deref().expect("network URL was checked"),
                source,
            );
            let outcome = input
                .status
                .map_or_else(|| "failed".into(), |status| format!("HTTP {status}"));
            PreviewTelemetryEvent {
                kind: input.kind,
                message: format!("{method} {url} · {outcome} · {phase}"),
                count: 1,
            }
        }
        _ => return Err("Preview telemetry kind is not allowed".into()),
    };
    Ok(normalized)
}

fn telemetry_nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Preview telemetry nonce unavailable".to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn telemetry_script(nonce: &str) -> String {
    let nonce = serde_json::to_string(nonce).expect("nonce is JSON-safe");
    format!(
        r#"(() => {{
  'use strict';
  const invoke = (command, args) => {{
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return Promise.reject(new Error('invoke unavailable'));
    return internals.invoke(command, args);
  }};
  const nonce = {nonce};
  let started = Date.now(), sent = 0;
  const submit = (event) => {{
    const now = Date.now();
    if (now - started >= 1000) {{ started = now; sent = 0; }}
    if (sent >= 12) return;
    sent += 1;
    try {{ void invoke('preview_telemetry_ingest', {{ event, nonce }}).catch(() => {{}}); }} catch (_) {{}}
  }};
  const text = (value) => {{
    try {{
      if (value instanceof Error) return String(value.name || 'Error') + ': ' + String(value.message || '');
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
      return '<non-text value>';
    }} catch (_) {{ return '<unavailable>'; }}
  }};
  const originalError = console.error.bind(console);
  console.error = (...args) => {{
    submit({{ kind: 'console-error', message: args.slice(0, 4).map(text).join(' ') }});
    return originalError(...args);
  }};
  addEventListener('error', (event) => {{
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {{
      submit({{ kind: 'network-failure', url: String(target.src || target.href), method: 'GET', phase: 'resource' }});
    }} else {{
      submit({{ kind: 'unhandled-error', message: text(event.error || event.message || 'Unhandled error') }});
    }}
  }}, true);
  addEventListener('unhandledrejection', (event) => submit({{ kind: 'unhandled-error', message: text(event.reason || 'Unhandled rejection') }}));
  if (typeof fetch === 'function') {{
    const originalFetch = fetch.bind(window);
    window.fetch = async (...args) => {{
      const request = args[0], init = args[1];
      const rawUrl = request && request.url ? request.url : String(request);
      let url;
      try {{ url = new URL(rawUrl, location.href).href; }} catch (_) {{ url = rawUrl; }}
      const method = String((init && init.method) || (request && request.method) || 'GET');
      try {{
        const response = await originalFetch(...args);
        if (!response.ok) submit({{ kind: 'network-failure', url, method, status: response.status, phase: 'fetch' }});
        return response;
      }} catch (error) {{ submit({{ kind: 'network-failure', url, method, phase: 'fetch' }}); throw error; }}
    }};
  }}
  if (typeof XMLHttpRequest === 'function') {{
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {{ this.__tunaraTelemetry = {{ method: String(method), url: String(url) }}; return open.call(this, method, url, ...rest); }};
    XMLHttpRequest.prototype.send = function(...args) {{
      const meta = this.__tunaraTelemetry || {{ method: 'GET', url: '' }};
      const report = () => {{ if (!this.status || this.status >= 400) submit({{ kind: 'network-failure', url: meta.url, method: meta.method, status: this.status || undefined, phase: 'xhr' }}); }};
      this.addEventListener('loadend', report, {{ once: true }});
      return send.apply(this, args);
    }};
  }}
}})();"#
    )
}

fn telemetry_summary(entry: &PreviewRuntimeEntry) -> PreviewTelemetrySummary {
    let events = entry
        .telemetry
        .iter()
        .map(|event| PreviewTelemetrySummaryEvent {
            kind: event.kind.clone(),
            message: event.message.clone(),
            count: event.count,
        })
        .collect::<Vec<_>>();
    let mut lines = vec![format!(
        "Preview failures (generation {})",
        entry.window_generation
    )];
    for event in &events {
        let count = if event.count > 1 {
            format!(" ×{}", event.count)
        } else {
            String::new()
        };
        lines.push(format!("[{}] {}{}", event.kind, event.message, count));
    }
    if entry.telemetry_dropped > 0 {
        lines.push(format!(
            "[bounded] {} event(s) dropped",
            entry.telemetry_dropped
        ));
    }
    PreviewTelemetrySummary {
        generation: entry.window_generation,
        events,
        dropped: entry.telemetry_dropped,
        text: lines.join("\n"),
    }
}

fn telemetry_send_text(entry: &PreviewRuntimeEntry) -> String {
    telemetry_summary(entry).text.replace(['\r', '\n'], " | ")
}

fn record_telemetry(
    entry: &mut PreviewRuntimeEntry,
    event: PreviewTelemetryInput,
) -> Result<(), String> {
    if entry.telemetry_rate_started.elapsed() >= TELEMETRY_RATE_WINDOW {
        entry.telemetry_rate_started = Instant::now();
        entry.telemetry_rate_count = 0;
    }
    if entry.telemetry_rate_count >= TELEMETRY_MAX_PER_WINDOW {
        entry.telemetry_dropped = entry.telemetry_dropped.saturating_add(1);
        return Ok(());
    }
    entry.telemetry_rate_count += 1;
    let normalized = normalize_telemetry_event(event, &entry.source)?;
    if let Some(existing) = entry.telemetry.iter_mut().find(|candidate| {
        candidate.kind == normalized.kind && candidate.message == normalized.message
    }) {
        existing.count = existing.count.saturating_add(1);
        return Ok(());
    }
    if entry.telemetry.len() == TELEMETRY_MAX_EVENTS {
        entry.telemetry.pop_front();
        entry.telemetry_dropped = entry.telemetry_dropped.saturating_add(1);
    }
    entry.telemetry.push_back(normalized);
    Ok(())
}

fn validate_telemetry_caller(
    label: &str,
    nonce: &str,
    current_url: &tauri::Url,
    entry: &PreviewRuntimeEntry,
) -> Result<(), String> {
    let source_url = entry
        .source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "Preview source URL is invalid".to_string())?;
    if !label.starts_with("preview-")
        || source_label(&entry.source) != label
        || nonce.len() != 64
        || entry.telemetry_nonce != nonce
        || !navigation_allowed(&allowed_origin(&source_url)?, current_url)
    {
        return Err("Preview telemetry source or generation changed".into());
    }
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
    hasher.update(source.physical_pty_id.unwrap_or_default().to_le_bytes());
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
        safe_source_url(&source.source_url)
    );
    let window_generation = app.state::<PreviewWindowState>().next_generation()?;
    let nonce = telemetry_nonce()?;
    let telemetry_script = telemetry_script(&nonce);
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
                viewport_mode: "reset".into(),
                requested_viewport: DEFAULT_VIEWPORT,
                telemetry_nonce: nonce,
                telemetry: VecDeque::with_capacity(TELEMETRY_MAX_EVENTS),
                telemetry_rate_started: Instant::now(),
                telemetry_rate_count: 0,
                telemetry_dropped: 0,
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
        .inner_size(DEFAULT_VIEWPORT.0 as f64, DEFAULT_VIEWPORT.1 as f64)
        .min_inner_size(320.0, 240.0)
        .on_navigation(move |target| navigation_allowed(&origin, target))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, event| {
            if let DownloadEvent::Requested { url, .. } = event {
                log::warn!("blocked Preview download: {url}");
            }
            false
        })
        .on_page_load(move |webview, payload| match payload.event() {
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
                if let Err(error) = webview.eval(&telemetry_script) {
                    log::warn!("Preview failure telemetry injection failed: {error}");
                }
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
    let chrome = window_chrome_inset(&window)?;
    window
        .set_size(LogicalSize::new(
            (DEFAULT_VIEWPORT.0 + chrome.0) as f64,
            (DEFAULT_VIEWPORT.1 + chrome.1) as f64,
        ))
        .map_err(|error| error.to_string())?;
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
) -> Result<Option<PreviewRuntimeState>, String> {
    validate_source_identity(&source)?;
    let label = source_label(&source);
    let state = app.state::<PreviewWindowState>();
    let status = {
        let entries = state
            .entries
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        entries.get(&label).map(|entry| {
            (
                entry.status,
                entry.viewport_mode.clone(),
                entry.requested_viewport,
                telemetry_summary(entry),
            )
        })
    };
    let Some((status, viewport_mode, requested_viewport, telemetry)) = status else {
        return Ok(None);
    };
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Preview window is unavailable".to_string())?;
    let current_url = window.url().map_err(|error| error.to_string())?;
    let (can_go_back, can_go_forward) = native_history(&window)?;
    let zoom_factor = native_zoom(&window)?;
    let actual = logical_webview_size(&window)?;
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let actual_width = actual.0;
    let actual_height = actual.1;
    Ok(Some(PreviewRuntimeState {
        status,
        current_url: current_url.to_string(),
        can_go_back,
        can_go_forward,
        zoom_factor,
        viewport: PreviewViewportState {
            mode: viewport_mode,
            requested_width: requested_viewport.0,
            requested_height: requested_viewport.1,
            actual_width,
            actual_height,
            outer_width: (outer.width as f64 / scale).round() as u32,
            outer_height: (outer.height as f64 / scale).round() as u32,
            exact: (actual_width, actual_height) == requested_viewport,
        },
        telemetry,
    }))
}

fn preview_window(
    app: &AppHandle,
    source: &PreviewSource,
) -> Result<(String, u64, tauri::WebviewWindow), String> {
    validate_source(source)?;
    let label = source_label(source);
    let state = app.state::<PreviewWindowState>();
    let generation = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .get(&label)
        .and_then(|entry| {
            (source_label(&entry.source) == label).then_some(entry.window_generation)
        });
    let Some(generation) = generation else {
        return Err("Preview source is not open".into());
    };
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Preview window is unavailable".to_string())?;
    Ok((label, generation, window))
}

#[tauri::command]
pub fn preview_set_zoom(app: AppHandle, source: PreviewSource, factor: f64) -> Result<(), String> {
    let factor = validate_zoom_factor(factor)?;
    let (label, generation, window) = preview_window(&app, &source)?;
    set_native_zoom(&window, factor)?;
    let current = app
        .state::<PreviewWindowState>()
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .get(&label)
        .map(|entry| entry.window_generation);
    if current != Some(generation) {
        return Err("Preview window generation changed during zoom".into());
    }
    Ok(())
}

#[tauri::command]
pub fn preview_reset_zoom(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    preview_set_zoom(app, source, 1.0)
}

async fn set_preview_viewport(
    app: &AppHandle,
    source: &PreviewSource,
    mode: &str,
    size: (u32, u32),
) -> Result<(), String> {
    let (label, generation, window) = preview_window(app, source)?;
    if (native_zoom(&window)? - 1.0).abs() > 0.001 {
        return Err("Reset Preview zoom to 100% before applying a CSS viewport".into());
    }
    let chrome = window_chrome_inset(&window)?;
    window
        .set_size(LogicalSize::new(
            (size.0 + chrome.0) as f64,
            (size.1 + chrome.1) as f64,
        ))
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(1);
    let actual_logical = loop {
        let logical = logical_webview_size(&window)?;
        if logical == size || Instant::now() >= deadline {
            break logical;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let state = app.state::<PreviewWindowState>();
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;
    let entry = entries
        .get_mut(&label)
        .ok_or_else(|| "Preview source is not open".to_string())?;
    if entry.window_generation != generation {
        return Err("Preview window generation changed during viewport action".into());
    }
    entry.viewport_mode = mode.into();
    entry.requested_viewport = size;
    if actual_logical != size {
        return Err(format!(
            "Preview viewport unavailable: requested {}x{}, actual {}x{}",
            size.0, size.1, actual_logical.0, actual_logical.1
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn preview_set_viewport(
    app: AppHandle,
    source: PreviewSource,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let size = validate_viewport(width, height)?;
    set_preview_viewport(&app, &source, "preset", size).await
}

#[tauri::command]
pub async fn preview_reset_viewport(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    set_preview_viewport(&app, &source, "reset", DEFAULT_VIEWPORT).await
}

#[tauri::command]
pub async fn preview_fit_viewport(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    let (_, _, window) = preview_window(&app, &source)?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Preview monitor is unavailable".to_string())?;
    let scale = monitor.scale_factor();
    let size = monitor.size();
    let chrome = window_chrome_inset(&window)?;
    let fitted = (
        ((size.width as f64 / scale) - 80.0).max(320.0).round() as u32,
        ((size.height as f64 / scale) - 120.0 - chrome.1 as f64)
            .max(240.0)
            .round() as u32,
    );
    set_preview_viewport(&app, &source, "fit", fitted).await
}

fn begin_history_load(app: &AppHandle, label: &str) -> Result<u64, String> {
    let state = app.state::<PreviewWindowState>();
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;
    let entry = entries
        .get_mut(label)
        .ok_or_else(|| "Preview source is not open".to_string())?;
    if entry.status != PreviewRuntimeStatus::Ready {
        return Err("Preview is not ready for navigation".into());
    }
    entry.status = PreviewRuntimeStatus::Loading;
    Ok(entry.window_generation)
}

fn fail_history_load(app: &AppHandle, label: &str, generation: u64) {
    if let Ok(mut entries) = app.state::<PreviewWindowState>().entries.lock() {
        if let Some(entry) = entries.get_mut(label) {
            if entry.window_generation == generation {
                entry.status = PreviewRuntimeStatus::Failed;
            }
        }
    }
}

#[tauri::command]
pub fn preview_navigate(
    app: AppHandle,
    source: PreviewSource,
    address: String,
) -> Result<(), String> {
    let (source_url, _) = validate_source(&source)?;
    let label = source_label(&source);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Preview window is unavailable".to_string())?;
    let current_url = window.url().map_err(|error| error.to_string())?;
    let target = normalize_address(&source_url, &current_url, &address)?;
    let generation = begin_history_load(&app, &label)?;
    window.navigate(target).map_err(|error| {
        fail_history_load(&app, &label, generation);
        error.to_string()
    })
}

fn preview_history_move(app: AppHandle, source: PreviewSource, back: bool) -> Result<(), String> {
    validate_source(&source)?;
    let label = source_label(&source);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "Preview window is unavailable".to_string())?;
    let generation = begin_history_load(&app, &label)?;
    native_history_move(&window, back).inspect_err(|_| {
        fail_history_load(&app, &label, generation);
    })
}

#[tauri::command]
pub fn preview_go_back(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    preview_history_move(app, source, true)
}

#[tauri::command]
pub fn preview_go_forward(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    preview_history_move(app, source, false)
}

#[tauri::command]
pub fn preview_telemetry_ingest(
    webview: tauri::WebviewWindow,
    event: PreviewTelemetryInput,
    nonce: String,
    state: tauri::State<PreviewWindowState>,
) -> Result<(), String> {
    let label = webview.label();
    let current_url = webview.url().map_err(|error| error.to_string())?;
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;
    let entry = entries
        .get_mut(label)
        .ok_or_else(|| "Preview telemetry source is closed".to_string())?;
    validate_telemetry_caller(label, &nonce, &current_url, entry)?;
    record_telemetry(entry, event)
}

#[tauri::command]
pub fn preview_telemetry_clear(
    source: PreviewSource,
    state: tauri::State<PreviewWindowState>,
) -> Result<(), String> {
    validate_source(&source)?;
    let label = source_label(&source);
    let mut entries = state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;
    let entry = entries
        .get_mut(&label)
        .ok_or_else(|| "Preview source is not open".to_string())?;
    if source_label(&entry.source) != label {
        return Err("Preview source identity changed".into());
    }
    entry.telemetry.clear();
    entry.telemetry_dropped = 0;
    entry.telemetry_rate_started = Instant::now();
    entry.telemetry_rate_count = 0;
    Ok(())
}

#[tauri::command]
pub fn preview_telemetry_send(
    source: PreviewSource,
    preview_state: tauri::State<PreviewWindowState>,
    pty_state: tauri::State<crate::modules::pty::PtyState>,
) -> Result<(), String> {
    validate_source(&source)?;
    let physical_pty_id = source
        .physical_pty_id
        .ok_or_else(|| "Preview source has no physical PTY".to_string())?;
    let label = source_label(&source);
    let entries = preview_state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?;
    let entry = entries
        .get(&label)
        .ok_or_else(|| "Preview source is not open".to_string())?;
    if source_label(&entry.source) != label
        || entry.source.physical_pty_id != Some(physical_pty_id)
        || entry.telemetry.is_empty()
    {
        return Err("Preview telemetry has no active matching PTY source".into());
    }
    let summary = telemetry_send_text(entry);
    if summary.contains(['\r', '\n']) {
        return Err("Preview telemetry send must not contain an execute character".into());
    }
    let session = pty_state
        .get(physical_pty_id)
        .ok_or_else(|| "Preview source PTY has exited".to_string())?;
    session.write(summary.as_bytes())
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
            physical_pty_id: Some(7),
            source_url: url.into(),
            transport: "local".into(),
            workspace_resolution: "resolved".into(),
            permission: "eligible".into(),
            state: "active".into(),
        }
    }

    fn runtime_entry(url: &str) -> PreviewRuntimeEntry {
        PreviewRuntimeEntry {
            source: source(url),
            status: PreviewRuntimeStatus::Ready,
            window_generation: 9,
            load_attempt: 1,
            loading_url: None,
            viewport_mode: "reset".into(),
            requested_viewport: DEFAULT_VIEWPORT,
            telemetry_nonce: "a".repeat(64),
            telemetry: VecDeque::new(),
            telemetry_rate_started: Instant::now(),
            telemetry_rate_count: 0,
            telemetry_dropped: 0,
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

    #[test]
    fn normalizes_relative_and_full_same_origin_addresses() {
        let source: tauri::Url = "http://127.0.0.1:4173/app/start?old=1".parse().unwrap();
        let current: tauri::Url = "http://127.0.0.1:4173/app/a".parse().unwrap();
        assert_eq!(
            normalize_address(&source, &current, "../b?q=1#two")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:4173/b?q=1#two"
        );
        assert_eq!(
            normalize_address(&source, &current, "http://127.0.0.1:4173/full")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:4173/full"
        );
        assert_eq!(
            normalize_address(&source, &current, "?next=1")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:4173/app/a?next=1"
        );
        assert_eq!(
            normalize_address(&source, &current, "#section")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:4173/app/a#section"
        );
    }

    #[test]
    fn address_navigation_rejects_every_origin_escape() {
        let source: tauri::Url = "http://localhost:4173/".parse().unwrap();
        for address in [
            "https://localhost:4173/",
            "http://127.0.0.1:4173/",
            "http://localhost:4174/",
            "https://example.com/",
            "http://user:pass@localhost:4173/",
            "file:///tmp/secret",
            "javascript:alert(1)",
            "//example.com/path",
        ] {
            assert!(
                normalize_address(&source, &source, address).is_err(),
                "accepted {address}"
            );
        }
        assert!(normalize_address(&source, &source, "   ").is_err());
    }

    #[test]
    fn zoom_accepts_only_finite_approved_presets() {
        for factor in ZOOM_PRESETS {
            assert_eq!(validate_zoom_factor(factor).unwrap(), factor);
        }
        for factor in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.49, 0.8, 2.01] {
            assert!(validate_zoom_factor(factor).is_err(), "accepted {factor}");
        }
    }

    #[test]
    fn viewport_accepts_only_approved_css_pixel_sizes() {
        for (width, height) in VIEWPORT_PRESETS {
            assert_eq!(validate_viewport(width, height).unwrap(), (width, height));
        }
        for (width, height) in [(0, 0), (390, 843), (980, 720), (9999, 9999)] {
            assert!(validate_viewport(width, height).is_err());
        }
    }

    #[test]
    fn telemetry_schema_accepts_only_failure_allowlist_and_size_budget() {
        let console: PreviewTelemetryInput = serde_json::from_value(serde_json::json!({
            "kind": "console-error", "message": "render failed"
        }))
        .unwrap();
        assert_eq!(
            normalize_telemetry_event(console, &source("http://localhost:4173/"))
                .unwrap()
                .kind,
            "console-error"
        );
        let unhandled: PreviewTelemetryInput = serde_json::from_value(serde_json::json!({
            "kind": "unhandled-error", "message": "rejected"
        }))
        .unwrap();
        assert!(normalize_telemetry_event(unhandled, &source("http://localhost:4173/")).is_ok());
        let network: PreviewTelemetryInput = serde_json::from_value(serde_json::json!({
            "kind": "network-failure", "url": "http://localhost:4173/api?q=secret#fragment", "method": "GET", "status": 503, "phase": "fetch"
        }))
        .unwrap();
        assert_eq!(
            normalize_telemetry_event(network, &source("http://localhost:4173/"))
                .unwrap()
                .message,
            "GET /api · HTTP 503 · fetch"
        );
        assert!(
            serde_json::from_value::<PreviewTelemetryInput>(serde_json::json!({
                "kind": "console-error", "message": "x", "body": "forbidden"
            }))
            .is_err()
        );
        let oversized: PreviewTelemetryInput = serde_json::from_value(serde_json::json!({
            "kind": "console-error", "message": "x".repeat(TELEMETRY_MAX_TEXT * 2 + 1)
        }))
        .unwrap();
        assert!(normalize_telemetry_event(oversized, &source("http://localhost:4173/")).is_err());
        let encoded: PreviewTelemetryInput = serde_json::from_value(serde_json::json!({
            "kind": "console-error", "message": "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWg=="
        }))
        .unwrap();
        assert!(normalize_telemetry_event(encoded, &source("http://localhost:4173/")).is_err());
        for invalid in [
            serde_json::json!({"kind": "network-failure", "url": "http://localhost:4173/a", "method": "GET"}),
            serde_json::json!({"kind": "network-failure", "url": "http://localhost:4173/a", "method": "GET", "phase": "fetch", "status": 200}),
            serde_json::json!({"kind": "network-failure", "message": "extra", "url": "http://localhost:4173/a", "method": "GET", "phase": "fetch"}),
        ] {
            let input: PreviewTelemetryInput = serde_json::from_value(invalid).unwrap();
            assert!(normalize_telemetry_event(input, &source("http://localhost:4173/")).is_err());
        }
    }

    #[test]
    fn telemetry_redacts_credentials_queries_fragments_paths_and_secrets() {
        let sanitized = sanitize_text(
            "Authorization: Bearer_abcdefghijklmnopqrstuvwxyz012345 username=person /Users/person/project https://user:pass@example.test/a?token=secret#private token=abcdef1234567890abcdef1234567890",
        );
        for forbidden in [
            "person",
            "user:pass",
            "token=secret",
            "#private",
            "abcdef1234567890",
        ] {
            assert!(
                !sanitized.contains(forbidden),
                "leaked {forbidden}: {sanitized}"
            );
        }
        assert!(sanitized.contains("<path>"));
        assert_eq!(
            safe_source_url("http://user:pass@localhost:4173/a?q=secret#private"),
            "http://localhost:4173/a"
        );
    }

    #[test]
    fn telemetry_deduplicates_and_uses_a_bounded_ring_and_rate_window() {
        let mut entry = runtime_entry("http://localhost:4173/");
        for _ in 0..3 {
            record_telemetry(
                &mut entry,
                PreviewTelemetryInput {
                    kind: "console-error".into(),
                    message: Some("same".into()),
                    url: None,
                    method: None,
                    status: None,
                    phase: None,
                },
            )
            .unwrap();
        }
        assert_eq!(entry.telemetry.len(), 1);
        assert_eq!(entry.telemetry[0].count, 3);
        for index in 0..TELEMETRY_MAX_EVENTS + 1 {
            record_telemetry(
                &mut entry,
                PreviewTelemetryInput {
                    kind: "console-error".into(),
                    message: Some(format!("unique-{index}")),
                    url: None,
                    method: None,
                    status: None,
                    phase: None,
                },
            )
            .unwrap();
        }
        assert_eq!(entry.telemetry.len(), TELEMETRY_MAX_EVENTS);
        assert!(entry.telemetry_dropped >= 2);
        while entry.telemetry_rate_count < TELEMETRY_MAX_PER_WINDOW {
            let rate_count = entry.telemetry_rate_count;
            record_telemetry(
                &mut entry,
                PreviewTelemetryInput {
                    kind: "console-error".into(),
                    message: Some(format!("rate-{rate_count}")),
                    url: None,
                    method: None,
                    status: None,
                    phase: None,
                },
            )
            .unwrap();
        }
        let dropped = entry.telemetry_dropped;
        record_telemetry(
            &mut entry,
            PreviewTelemetryInput {
                kind: "console-error".into(),
                message: Some("over-rate".into()),
                url: None,
                method: None,
                status: None,
                phase: None,
            },
        )
        .unwrap();
        assert_eq!(entry.telemetry_dropped, dropped + 1);
    }

    #[test]
    fn telemetry_send_is_single_line_and_generation_bound() {
        let mut entry = runtime_entry("http://localhost:4173/");
        record_telemetry(
            &mut entry,
            PreviewTelemetryInput {
                kind: "unhandled-error".into(),
                message: Some("line one\nline two".into()),
                url: None,
                method: None,
                status: None,
                phase: None,
            },
        )
        .unwrap();
        let text = telemetry_send_text(&entry);
        assert!(text.contains("generation 9"));
        assert!(!text.contains(['\r', '\n']));
    }

    #[test]
    fn telemetry_caller_rejects_old_generation_and_cross_source_or_port() {
        let entry = runtime_entry("http://localhost:4173/app?secret=value#fragment");
        let label = source_label(&entry.source);
        let current: tauri::Url = "http://localhost:4173/next".parse().unwrap();
        assert!(
            validate_telemetry_caller(&label, &entry.telemetry_nonce, &current, &entry).is_ok()
        );
        assert!(validate_telemetry_caller(&label, &"b".repeat(64), &current, &entry).is_err());
        assert!(validate_telemetry_caller(
            &source_label(&source("http://localhost:4174/")),
            &entry.telemetry_nonce,
            &current,
            &entry,
        )
        .is_err());
        let cross_port: tauri::Url = "http://localhost:4174/next".parse().unwrap();
        assert!(
            validate_telemetry_caller(&label, &entry.telemetry_nonce, &cross_port, &entry).is_err()
        );
    }

    #[test]
    fn telemetry_nonce_is_random_and_fixed_width() {
        let first = telemetry_nonce().unwrap();
        let second = telemetry_nonce().unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert_ne!(first, second);
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
