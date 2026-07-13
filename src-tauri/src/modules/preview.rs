use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::sync::mpsc;
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::Write,
    net::{Ipv4Addr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

use crate::modules::pty::PtyState;

const LOAD_FAILURE_TIMEOUT: Duration = Duration::from_secs(8);
const LOOPBACK_CONNECT_TIMEOUT: Duration = Duration::from_millis(350);
const DEFAULT_VIEWPORT: (u32, u32) = (980, 720);
const VIEWPORT_PRESETS: [(u32, u32); 3] = [(390, 844), (768, 1024), (1280, 720)];
const ZOOM_PRESETS: [f64; 6] = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5];
const TELEMETRY_MAX_EVENTS: usize = 32;
const TELEMETRY_MAX_TEXT: usize = 512;
const TELEMETRY_RATE_WINDOW: Duration = Duration::from_secs(10);
const TELEMETRY_MAX_PER_WINDOW: u32 = 40;
const RESTART_COMMAND_MAX_BYTES: usize = 384;
const MAX_CAPTURE_PIXELS: u64 = 16_777_216;
const MAX_CAPTURE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RUNTIME_CAPTURES: usize = 64;
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
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
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_user: Option<String>,
    remote_source_url: Option<String>,
    tunnel_id: Option<String>,
    restart_provenance: Option<PreviewCommandProvenance>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewCommandProvenance {
    generation: String,
    sequence: u64,
    command: String,
    submitted_at: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewSourceContext {
    repository_id: String,
    worktree_id: String,
    workspace_id: String,
    session_id: String,
    terminal_id: String,
    physical_pty_id: Option<u32>,
    transport: String,
    workspace_resolution: String,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCaptureOptions {
    format: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCaptureResult {
    capture_id: String,
    local_ref: String,
    source_origin: String,
    source_summary: String,
    prepared_text: String,
    captured_at_ms: u64,
    viewport_css_width: u32,
    viewport_css_height: u32,
    zoom_factor: f64,
    window_generation: u64,
    image_format: String,
    image_width: u32,
    image_height: u32,
    image_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSendReceipt {
    terminal_ref: String,
    bytes_written: usize,
    executed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCaptureMetadata {
    schema_version: u8,
    capture_id: String,
    local_ref: String,
    source: PreviewCaptureSourceMetadata,
    captured_at_ms: u64,
    viewport_css: PreviewCaptureViewportMetadata,
    zoom_factor: f64,
    window_generation: u64,
    image: PreviewCaptureImageMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCaptureSourceMetadata {
    repository_ref: String,
    worktree_ref: String,
    workspace_ref: String,
    session_ref: String,
    terminal_ref: String,
    source_url_ref: String,
    source_origin: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCaptureViewportMetadata {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewCaptureImageMetadata {
    format: String,
    width: u32,
    height: u32,
    byte_size: usize,
    sha256: String,
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
    restart: PreviewRestartSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRestartSummary {
    eligible: bool,
    command: Option<String>,
    reason: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewTunnelStatus {
    Opening,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTunnelView {
    status: PreviewTunnelStatus,
    remote_port: u16,
    local_endpoint: Option<String>,
    preview_source: Option<PreviewSource>,
    reason: Option<String>,
}

#[derive(Debug)]
struct PreviewTunnelRuntime {
    original_source: PreviewSource,
    preview_source: Option<PreviewSource>,
    status: PreviewTunnelStatus,
    remote_port: u16,
    generation: u64,
    cancel: Option<tokio::sync::watch::Sender<bool>>,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct PreviewTerminalCommandRuntime {
    context: PreviewSourceContext,
    generation: String,
    sequence: u64,
    submitted_at: u64,
    command_fingerprint: String,
    restart_command: Option<String>,
    busy: bool,
    prepared: bool,
}

#[derive(Debug, Clone)]
struct PreviewCaptureRecord {
    source_label: String,
    window_generation: u64,
    captured_at_ms: u64,
    local_ref: String,
    source_origin: String,
    source_summary: String,
    terminal_ref: String,
}

#[derive(Default)]
pub struct PreviewWindowState {
    entries: Mutex<HashMap<String, PreviewRuntimeEntry>>,
    terminal_commands: Mutex<HashMap<String, PreviewTerminalCommandRuntime>>,
    next_window_generation: Mutex<u64>,
    tunnels: Mutex<HashMap<String, PreviewTunnelRuntime>>,
    used_tunnel_nonces: Mutex<VecDeque<String>>,
    next_tunnel_generation: Mutex<u64>,
    remote_sources: Mutex<HashMap<String, PreviewSource>>,
    captures: Mutex<HashMap<String, PreviewCaptureRecord>>,
    next_capture_sequence: Mutex<u64>,
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

    fn next_tunnel_generation(&self) -> Result<u64, String> {
        let mut generation = self
            .next_tunnel_generation
            .lock()
            .map_err(|_| "Preview tunnel generation lock poisoned".to_string())?;
        *generation = generation.saturating_add(1);
        Ok(*generation)
    }

    pub fn close_tunnels_for_pty(&self, app: &AppHandle, physical_pty_id: u32) {
        let removed = self.remove_tunnels(|runtime| {
            runtime.original_source.physical_pty_id == Some(physical_pty_id)
        });
        close_removed_tunnels(app, removed);
        if let Ok(mut sources) = self.remote_sources.lock() {
            sources.retain(|_, source| source.physical_pty_id != Some(physical_pty_id));
        }
    }

    pub fn close_all_tunnels(&self, app: &AppHandle) {
        let removed = self.remove_tunnels(|_| true);
        close_removed_tunnels(app, removed);
        if let Ok(mut sources) = self.remote_sources.lock() {
            sources.clear();
        }
    }

    fn remove_tunnels(
        &self,
        predicate: impl Fn(&PreviewTunnelRuntime) -> bool,
    ) -> Vec<PreviewTunnelRuntime> {
        let Ok(mut tunnels) = self.tunnels.lock() else {
            return Vec::new();
        };
        let ids = tunnels
            .iter()
            .filter_map(|(id, runtime)| predicate(runtime).then_some(id.clone()))
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| tunnels.remove(&id))
            .collect()
    }

    fn next_capture_sequence(&self) -> Result<u64, String> {
        let mut sequence = self
            .next_capture_sequence
            .lock()
            .map_err(|_| "Preview capture sequence lock poisoned".to_string())?;
        *sequence = sequence.saturating_add(1);
        Ok(*sequence)
    }
}

fn close_removed_tunnels(app: &AppHandle, removed: Vec<PreviewTunnelRuntime>) {
    for runtime in removed {
        if let Some(cancel) = runtime.cancel {
            let _ = cancel.send(true);
        }
        if let Some(preview_source) = runtime.preview_source {
            let label = source_label(&preview_source);
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
            if let Ok(mut entries) = app.state::<PreviewWindowState>().entries.lock() {
                entries.remove(&label);
            }
        }
    }
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn safe_ref(kind: &str, value: &str) -> String {
    format!("{kind}-sha256:{}", &sha256_hex(value)[..16])
}

fn safe_source_origin(url: &tauri::Url) -> Result<String, String> {
    let origin = allowed_origin(url)?;
    let host = if origin.host == "::1" {
        "[::1]".to_string()
    } else {
        origin.host
    };
    Ok(format!("{}://{}:{}", origin.scheme, host, origin.port))
}

fn safe_local_ref(path: &Path, capture_id: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(relative) = path.strip_prefix(home) {
            return format!("$HOME/{}", relative.to_string_lossy());
        }
    }
    format!("preview-evidence://{capture_id}")
}

fn validate_capture_format(format: &str) -> Result<&'static str, String> {
    if format.eq_ignore_ascii_case("png") {
        Ok("png")
    } else {
        Err("Preview capture only supports PNG".into())
    }
}

fn validate_capture_size(width: u32, height: u32, bytes: usize) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err("Preview capture returned an empty image".into());
    }
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_CAPTURE_PIXELS {
        return Err("Preview capture exceeds the pixel safety limit".into());
    }
    if bytes == 0 || bytes > MAX_CAPTURE_BYTES {
        return Err("Preview capture exceeds the encoded size safety limit".into());
    }
    Ok(())
}

fn capture_source_metadata(
    source: &PreviewSource,
    url: &tauri::Url,
) -> Result<PreviewCaptureSourceMetadata, String> {
    Ok(PreviewCaptureSourceMetadata {
        repository_ref: safe_ref("repository", &source.repository_id),
        worktree_ref: safe_ref("worktree", &source.worktree_id),
        workspace_ref: safe_ref("workspace", &source.workspace_id),
        session_ref: safe_ref("session", &source.session_id),
        terminal_ref: safe_ref("terminal", &source.terminal_id),
        source_url_ref: safe_ref("url", url.as_str()),
        source_origin: safe_source_origin(url)?,
    })
}

fn capture_source_summary(source: &PreviewCaptureSourceMetadata) -> String {
    format!(
        "repo={} worktree={} workspace={} session={} terminal={}",
        source.repository_ref,
        source.worktree_ref,
        source.workspace_ref,
        source.session_ref,
        source.terminal_ref
    )
}

fn capture_prepared_text(record: &PreviewCaptureRecord) -> String {
    format!(
        "Preview screenshot: ref={} origin={} source={} generation={}",
        record.local_ref, record.source_origin, record.source_summary, record.window_generation
    )
}

fn capture_directory(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("preview-evidence"))
        .map_err(|error| error.to_string())
}

fn write_capture_artifacts(
    directory: &Path,
    capture_id: &str,
    png: &[u8],
    metadata: &PreviewCaptureMetadata,
) -> Result<(PathBuf, PathBuf), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let image_path = directory.join(format!("{capture_id}.png"));
    let metadata_path = directory.join(format!("{capture_id}.json"));
    let mut image = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&image_path)
        .map_err(|error| error.to_string())?;
    if let Err(error) = image.write_all(png).and_then(|_| image.sync_all()) {
        let _ = fs::remove_file(&image_path);
        return Err(error.to_string());
    }
    let metadata_bytes = serde_json::to_vec_pretty(metadata).map_err(|error| error.to_string())?;
    let mut metadata_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&metadata_path)
    {
        Ok(file) => file,
        Err(error) => {
            let _ = fs::remove_file(&image_path);
            return Err(error.to_string());
        }
    };
    if let Err(error) = metadata_file
        .write_all(&metadata_bytes)
        .and_then(|_| metadata_file.sync_all())
    {
        let _ = fs::remove_file(&image_path);
        let _ = fs::remove_file(&metadata_path);
        return Err(error.to_string());
    }
    Ok((image_path, metadata_path))
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
        .map(|host| host.trim_matches(['[', ']']).to_ascii_lowercase())
        .ok_or_else(|| "Preview URL has no host".to_string())?;
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err("Preview only accepts exact loopback hosts".into());
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Preview URL has no valid port".to_string())?;
    if port == 0 {
        return Err("Preview URL port must be in 1..65535".into());
    }
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

fn validate_source_with_state(
    source: &PreviewSource,
    state: &PreviewWindowState,
) -> Result<(tauri::Url, AllowedOrigin), String> {
    if source.transport == "local" && source.permission == "eligible" {
        return validate_source(source);
    }
    if source.transport != "ssh"
        || source.permission != "forwarded"
        || source.state != "active"
        || source.workspace_resolution != "resolved"
    {
        return Err("Preview requires an active eligible local or ready forwarded source".into());
    }
    validate_source_identity(source)?;
    let tunnel_id = source
        .tunnel_id
        .as_deref()
        .ok_or_else(|| "Forwarded Preview has no tunnel identity".to_string())?;
    let tunnels = state
        .tunnels
        .lock()
        .map_err(|_| "Preview tunnel state lock poisoned".to_string())?;
    let tunnel = tunnels
        .get(tunnel_id)
        .ok_or_else(|| "Forwarded Preview tunnel is closed".to_string())?;
    if tunnel.status != PreviewTunnelStatus::Ready || tunnel.preview_source.as_ref() != Some(source)
    {
        return Err("Forwarded Preview source or tunnel generation changed".into());
    }
    let url = source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "Forwarded Preview URL is invalid".to_string())?;
    let origin = allowed_origin(&url)?;
    Ok((url, origin))
}

fn validate_remote_tunnel_source(
    source: &PreviewSource,
) -> Result<(tauri::Url, String, u16), String> {
    if source.transport != "ssh"
        || source.permission != "remote-manual"
        || source.state != "active"
        || source.workspace_resolution != "resolved"
        || source.remote_source_url.is_some()
        || source.tunnel_id.is_some()
    {
        return Err("SSH Preview tunnel requires an active resolved remote-manual source".into());
    }
    validate_source_identity(source)?;
    let url = source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "SSH Preview source URL is invalid".to_string())?;
    let origin = allowed_origin(&url)?;
    Ok((url, origin.host, origin.port))
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
    if source.transport == "ssh"
        && (source.ssh_host.as_deref().is_none_or(str::is_empty)
            || source.ssh_port.is_none()
            || source.ssh_user.as_deref().is_none_or(str::is_empty))
    {
        return Err("Preview SSH source identity is incomplete".into());
    }
    let url = source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "Preview URL is invalid".to_string())?;
    allowed_origin(&url)?;
    Ok(())
}

fn validate_terminal_context(context: &PreviewSourceContext) -> Result<u32, String> {
    if !matches!(context.transport.as_str(), "local" | "ssh")
        || context.workspace_resolution != "resolved"
    {
        return Err("Preview terminal context must be resolved".into());
    }
    if context.repository_id.is_empty()
        || context.worktree_id.is_empty()
        || context.session_id.is_empty()
        || context.terminal_id.is_empty()
        || context.workspace_id != format!("{}::{}", context.repository_id, context.worktree_id)
        || !context
            .terminal_id
            .starts_with(&format!("{}:", context.session_id))
    {
        return Err("Preview terminal identity is incomplete or inconsistent".into());
    }
    if context.transport == "ssh"
        && (context.ssh_host.as_deref().is_none_or(str::is_empty)
            || context.ssh_port.is_none()
            || context.ssh_user.as_deref().is_none_or(str::is_empty))
    {
        return Err("Preview SSH terminal identity is incomplete".into());
    }
    context
        .physical_pty_id
        .ok_or_else(|| "Preview terminal has no physical PTY".into())
}

fn restart_token_is_safe(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_-./:=,@%+".contains(character))
}

fn restart_script_is_safe(script: &str) -> bool {
    matches!(
        script.split(':').next().unwrap_or_default(),
        "dev" | "start" | "serve" | "preview" | "web"
    ) && script
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_:-".contains(character))
}

fn validate_restart_command(command: &str) -> Result<String, String> {
    if command.is_empty() || command.len() > RESTART_COMMAND_MAX_BYTES || command != command.trim()
    {
        return Err("Preview restart command is empty, padded, or too long".into());
    }
    if command
        .chars()
        .any(|character| character.is_control() || "\r\n;&|<>`$(){}[]\\\"'!?*~".contains(character))
    {
        return Err(
            "Preview restart command contains shell structure or control characters".into(),
        );
    }
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() || tokens.iter().any(|token| !restart_token_is_safe(token)) {
        return Err("Preview restart command contains an unsupported token".into());
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0]);
    let safe = match executable {
        "npm" => match tokens.as_slice() {
            [_, "start", rest @ ..] => rest.iter().all(|token| restart_token_is_safe(token)),
            [_, "run", script, rest @ ..] => {
                restart_script_is_safe(script)
                    && rest.iter().all(|token| restart_token_is_safe(token))
            }
            _ => false,
        },
        "pnpm" | "yarn" | "bun" => match tokens.as_slice() {
            [_, "run", script, rest @ ..] => {
                restart_script_is_safe(script)
                    && rest.iter().all(|token| restart_token_is_safe(token))
            }
            [_, script, rest @ ..] => {
                restart_script_is_safe(script)
                    && rest.iter().all(|token| restart_token_is_safe(token))
            }
            _ => false,
        },
        "python" | "python3" => matches!(tokens.as_slice(), [_, "-m", "http.server", ..]),
        "vite" => true,
        "next" | "astro" => tokens.get(1) == Some(&"dev"),
        "ng" => tokens.get(1) == Some(&"serve"),
        "deno" => {
            tokens.get(1) == Some(&"task")
                && tokens
                    .get(2)
                    .is_some_and(|script| restart_script_is_safe(script))
        }
        _ => false,
    };
    if !safe {
        return Err("Preview restart command is not an approved service-start shape".into());
    }
    Ok(command.to_string())
}

fn source_context(source: &PreviewSource) -> PreviewSourceContext {
    PreviewSourceContext {
        repository_id: source.repository_id.clone(),
        worktree_id: source.worktree_id.clone(),
        workspace_id: source.workspace_id.clone(),
        session_id: source.session_id.clone(),
        terminal_id: source.terminal_id.clone(),
        physical_pty_id: source.physical_pty_id,
        transport: source.transport.clone(),
        workspace_resolution: source.workspace_resolution.clone(),
        ssh_host: source.ssh_host.clone(),
        ssh_port: source.ssh_port,
        ssh_user: source.ssh_user.clone(),
    }
}

fn command_fingerprint(command: &str) -> String {
    format!("{:x}", Sha256::digest(command.as_bytes()))
}

fn terminal_command_runtime(
    context: PreviewSourceContext,
    provenance: PreviewCommandProvenance,
    busy: bool,
) -> PreviewTerminalCommandRuntime {
    let command_fingerprint = command_fingerprint(&provenance.command);
    let restart_command = validate_restart_command(&provenance.command).ok();
    PreviewTerminalCommandRuntime {
        context,
        generation: provenance.generation,
        sequence: provenance.sequence,
        submitted_at: provenance.submitted_at,
        command_fingerprint,
        restart_command,
        busy,
        prepared: false,
    }
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
    for value in [
        source.ssh_host.as_deref().unwrap_or_default(),
        source.ssh_user.as_deref().unwrap_or_default(),
        source.remote_source_url.as_deref().unwrap_or_default(),
        source.tunnel_id.as_deref().unwrap_or_default(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    hasher.update(source.ssh_port.unwrap_or_default().to_le_bytes());
    format!("preview-{:x}", hasher.finalize())[..32].to_string()
}

fn tunnel_nonce_is_valid(nonce: &str) -> bool {
    nonce.len() == 64 && nonce.chars().all(|character| character.is_ascii_hexdigit())
}

fn tunnel_view(runtime: &PreviewTunnelRuntime) -> PreviewTunnelView {
    PreviewTunnelView {
        status: runtime.status,
        remote_port: runtime.remote_port,
        local_endpoint: runtime
            .preview_source
            .as_ref()
            .map(|source| safe_source_url(&source.source_url)),
        preview_source: runtime.preview_source.clone(),
        reason: runtime.reason.clone(),
    }
}

fn ssh_session_for_source(
    source: &PreviewSource,
    pty_state: &crate::modules::pty::PtyState,
) -> Result<std::sync::Arc<crate::modules::pty::Session>, String> {
    let physical_pty_id = source
        .physical_pty_id
        .ok_or_else(|| "SSH Preview source has no physical PTY".to_string())?;
    let session = pty_state
        .get(physical_pty_id)
        .ok_or_else(|| "SSH Preview source PTY has exited".to_string())?;
    let crate::modules::pty::Session::Ssh(ssh) = session.as_ref() else {
        return Err("SSH Preview source is not an SSH session".into());
    };
    let (host, port, user, logical_session_id) = ssh.identity();
    if ssh.is_closed()
        || source.ssh_host.as_deref() != Some(host)
        || source.ssh_port != Some(port)
        || source.ssh_user.as_deref() != Some(user)
        || logical_session_id != source.session_id
        || !source
            .terminal_id
            .starts_with(&format!("{}:", logical_session_id))
    {
        return Err("SSH Preview transport identity or generation changed".into());
    }
    Ok(session)
}

fn derived_forwarded_source(
    source: &PreviewSource,
    tunnel_id: &str,
    local_port: u16,
) -> Result<PreviewSource, String> {
    let mut url = source
        .source_url
        .parse::<tauri::Url>()
        .map_err(|_| "SSH Preview source URL is invalid".to_string())?;
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| "Cannot derive local Preview host".to_string())?;
    url.set_port(Some(local_port))
        .map_err(|_| "Cannot derive local Preview port".to_string())?;
    let mut derived = source.clone();
    derived.remote_source_url = Some(source.source_url.clone());
    derived.source_url = url.to_string();
    derived.permission = "forwarded".into();
    derived.tunnel_id = Some(tunnel_id.into());
    derived.restart_provenance = None;
    Ok(derived)
}

fn matching_tunnel_id(
    state: &PreviewWindowState,
    source: &PreviewSource,
) -> Result<Option<String>, String> {
    let tunnels = state
        .tunnels
        .lock()
        .map_err(|_| "Preview tunnel state lock poisoned".to_string())?;
    Ok(tunnels.iter().find_map(|(id, runtime)| {
        (runtime.original_source == *source || runtime.preview_source.as_ref() == Some(source))
            .then_some(id.clone())
    }))
}

fn restart_summary(
    entry: &PreviewRuntimeEntry,
    requested_source: &PreviewSource,
    commands: &HashMap<String, PreviewTerminalCommandRuntime>,
    pty_state: &crate::modules::pty::PtyState,
) -> PreviewRestartSummary {
    let unavailable = |reason: &str| PreviewRestartSummary {
        eligible: false,
        command: None,
        reason: reason.into(),
    };
    if requested_source.state != "active" {
        return unavailable("source-stale");
    }
    if entry.status != PreviewRuntimeStatus::Failed {
        return unavailable("not-failed");
    }
    let Some(physical_pty_id) = requested_source.physical_pty_id else {
        return unavailable("pty-exited");
    };
    if pty_state.get(physical_pty_id).is_none() {
        return unavailable("pty-exited");
    }
    let Some(provenance) = entry.source.restart_provenance.as_ref() else {
        return unavailable("command-unavailable");
    };
    if requested_source.restart_provenance.as_ref() != Some(provenance) {
        return unavailable("provenance-changed");
    }
    let Some(command) = commands.get(&requested_source.terminal_id) else {
        return unavailable("command-unavailable");
    };
    if command.context != source_context(requested_source)
        || command.generation != provenance.generation
        || command.sequence != provenance.sequence
        || command.submitted_at != provenance.submitted_at
        || command.command_fingerprint != command_fingerprint(&provenance.command)
        || command.restart_command.as_deref() != Some(provenance.command.as_str())
        || command.context.physical_pty_id != Some(physical_pty_id)
    {
        return unavailable("provenance-changed");
    }
    if command.busy {
        return unavailable("terminal-busy");
    }
    if command.prepared {
        return unavailable("already-prepared");
    }
    let Ok(validated) = validate_restart_command(&provenance.command) else {
        return unavailable("command-unavailable");
    };
    PreviewRestartSummary {
        eligible: true,
        command: Some(validated),
        reason: "ready".into(),
    }
}

fn command_proves_source_generation(
    source: &PreviewSource,
    commands: &HashMap<String, PreviewTerminalCommandRuntime>,
) -> bool {
    let Some(provenance) = source.restart_provenance.as_ref() else {
        return false;
    };
    let Some(command) = commands.get(&source.terminal_id) else {
        return false;
    };
    command.context == source_context(source)
        && command.generation == provenance.generation
        && command.sequence == provenance.sequence
        && command.submitted_at == provenance.submitted_at
        && command.command_fingerprint == command_fingerprint(&provenance.command)
        && command.restart_command.as_deref() == Some(provenance.command.as_str())
}

#[tauri::command]
pub fn preview_remote_source_observed(
    source: PreviewSource,
    preview_state: tauri::State<PreviewWindowState>,
    pty_state: tauri::State<crate::modules::pty::PtyState>,
) -> Result<(), String> {
    validate_remote_tunnel_source(&source)?;
    ssh_session_for_source(&source, &pty_state)?;
    preview_state
        .remote_sources
        .lock()
        .map_err(|_| "Preview remote source lock poisoned".to_string())?
        .insert(source_label(&source), source);
    Ok(())
}

#[tauri::command]
pub async fn preview_tunnel_open(
    app: AppHandle,
    source: PreviewSource,
    action_nonce: String,
    preview_state: tauri::State<'_, PreviewWindowState>,
    pty_state: tauri::State<'_, crate::modules::pty::PtyState>,
) -> Result<PreviewTunnelView, String> {
    let (_, remote_host, remote_port) = validate_remote_tunnel_source(&source)?;
    if !tunnel_nonce_is_valid(&action_nonce) {
        return Err("SSH Preview action nonce is invalid".into());
    }
    let source_key = source_label(&source);
    let registered = preview_state
        .remote_sources
        .lock()
        .map_err(|_| "Preview remote source lock poisoned".to_string())?
        .get(&source_key)
        .cloned();
    if registered.as_ref() != Some(&source) {
        return Err("SSH Preview source is not the current observed source".into());
    }
    let session_before = ssh_session_for_source(&source, &pty_state)?;
    {
        let mut used = preview_state
            .used_tunnel_nonces
            .lock()
            .map_err(|_| "Preview tunnel nonce lock poisoned".to_string())?;
        if used.iter().any(|nonce| nonce == &action_nonce) {
            return Err("SSH Preview action nonce was already used".into());
        }
        if used.len() >= 256 {
            used.pop_front();
        }
        used.push_back(action_nonce.clone());
    }
    let generation = preview_state.next_tunnel_generation()?;
    let tunnel_id = telemetry_nonce()?;
    {
        let mut tunnels = preview_state
            .tunnels
            .lock()
            .map_err(|_| "Preview tunnel state lock poisoned".to_string())?;
        let existing = tunnels
            .values()
            .find(|runtime| runtime.original_source == source);
        if existing.is_some_and(|runtime| runtime.status != PreviewTunnelStatus::Failed) {
            return Err("SSH Preview tunnel is already opening or ready".into());
        }
        tunnels.retain(|_, runtime| runtime.original_source != source);
        tunnels.insert(
            tunnel_id.clone(),
            PreviewTunnelRuntime {
                original_source: source.clone(),
                preview_source: None,
                status: PreviewTunnelStatus::Opening,
                remote_port,
                generation,
                cancel: None,
                reason: None,
            },
        );
    }

    let opening = async {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("Cannot bind local loopback Preview port: {error}"))?;
        let local_addr = listener
            .local_addr()
            .map_err(|error| format!("Cannot read local Preview endpoint: {error}"))?;
        let crate::modules::pty::Session::Ssh(ssh_before) = session_before.as_ref() else {
            return Err("SSH Preview source is not an SSH session".into());
        };
        ssh_before.probe_direct_tcpip(&remote_host, remote_port).await?;

        let registered_after = preview_state
            .remote_sources
            .lock()
            .map_err(|_| "Preview remote source lock poisoned".to_string())?
            .get(&source_key)
            .cloned();
        if registered_after.as_ref() != Some(&source) {
            return Err("SSH Preview source changed while opening tunnel".into());
        }
        let session_after = ssh_session_for_source(&source, &pty_state)?;
        if !std::sync::Arc::ptr_eq(&session_before, &session_after) {
            return Err("SSH Preview session reconnected while opening tunnel".into());
        }
        let preview_source = derived_forwarded_source(&source, &tunnel_id, local_addr.port())?;
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        {
            let mut tunnels = preview_state
                .tunnels
                .lock()
                .map_err(|_| "Preview tunnel state lock poisoned".to_string())?;
            let runtime = tunnels
                .get_mut(&tunnel_id)
                .ok_or_else(|| "SSH Preview tunnel was closed while opening".to_string())?;
            if runtime.generation != generation
                || runtime.status != PreviewTunnelStatus::Opening
                || runtime.original_source != source
            {
                return Err("SSH Preview tunnel generation changed while opening".into());
            }
            runtime.preview_source = Some(preview_source.clone());
            runtime.status = PreviewTunnelStatus::Ready;
            runtime.cancel = Some(cancel_tx);
        }

        let app_for_task = app.clone();
        let tunnel_id_for_task = tunnel_id.clone();
        let session_for_task = session_after.clone();
        let remote_host_for_task = remote_host.clone();
        tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            let reason = loop {
                let crate::modules::pty::Session::Ssh(ssh) = session_for_task.as_ref() else {
                    break "SSH session identity changed".to_string();
                };
                tokio::select! {
                    biased;
                    changed = cancel_rx.changed() => {
                        if changed.is_err() || *cancel_rx.borrow() {
                            break "closed by user".to_string();
                        }
                    }
                    _ = ssh.wait_closed() => break "SSH session disconnected".to_string(),
                    accepted = listener.accept(), if connections.len() < 32 => match accepted {
                        Ok((stream, address)) if address.ip().is_loopback() => {
                            let session = session_for_task.clone();
                            let host = remote_host_for_task.clone();
                            connections.spawn(async move {
                                let crate::modules::pty::Session::Ssh(ssh) = session.as_ref() else {
                                    return Err("SSH session identity changed".to_string());
                                };
                                ssh.forward_loopback_stream(stream, &host, remote_port)
                                    .await
                            });
                        }
                        Ok(_) => {}
                        Err(error) => break format!("local Preview listener failed: {error}"),
                    },
                    completed = connections.join_next(), if !connections.is_empty() => match completed {
                        Some(Ok(Ok(()))) | None => {}
                        Some(Ok(Err(error))) => break format!("remote Preview relay failed: {error}"),
                        Some(Err(error)) => break format!("local Preview relay task failed: {error}"),
                    }
                }
            };
            connections.abort_all();
            let state = app_for_task.state::<PreviewWindowState>();
            let preview_source = if let Ok(mut tunnels) = state.tunnels.lock() {
                tunnels.get_mut(&tunnel_id_for_task).and_then(|runtime| {
                    if runtime.generation == generation && runtime.status == PreviewTunnelStatus::Ready {
                        runtime.status = PreviewTunnelStatus::Failed;
                        runtime.reason = Some(reason);
                        runtime.cancel = None;
                        runtime.preview_source.clone()
                    } else {
                        None
                    }
                })
            } else {
                None
            };
            if let Some(source) = preview_source {
                let label = source_label(&source);
                if let Ok(mut entries) = state.entries.lock() {
                    if let Some(entry) = entries.get_mut(&label) {
                        entry.status = PreviewRuntimeStatus::Failed;
                    }
                }
            }
        });
        Ok::<PreviewSource, String>(preview_source)
    }
    .await;

    match opening {
        Ok(_) => {
            let tunnels = preview_state
                .tunnels
                .lock()
                .map_err(|_| "Preview tunnel state lock poisoned".to_string())?;
            tunnels
                .get(&tunnel_id)
                .map(tunnel_view)
                .ok_or_else(|| "SSH Preview tunnel disappeared after opening".to_string())
        }
        Err(error) => {
            if let Ok(mut tunnels) = preview_state.tunnels.lock() {
                if let Some(runtime) = tunnels.get_mut(&tunnel_id) {
                    if runtime.generation == generation {
                        runtime.status = PreviewTunnelStatus::Failed;
                        runtime.reason = Some(error.clone());
                        runtime.cancel = None;
                        runtime.preview_source = None;
                    }
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn preview_tunnel_status(
    source: PreviewSource,
    state: tauri::State<PreviewWindowState>,
) -> Result<Option<PreviewTunnelView>, String> {
    validate_source_identity(&source)?;
    let Some(id) = matching_tunnel_id(&state, &source)? else {
        return Ok(None);
    };
    let tunnels = state
        .tunnels
        .lock()
        .map_err(|_| "Preview tunnel state lock poisoned".to_string())?;
    Ok(tunnels.get(&id).map(tunnel_view))
}

#[tauri::command]
pub fn preview_tunnel_close(
    app: AppHandle,
    source: PreviewSource,
    state: tauri::State<PreviewWindowState>,
) -> Result<(), String> {
    validate_source_identity(&source)?;
    let Some(id) = matching_tunnel_id(&state, &source)? else {
        return Ok(());
    };
    let removed = state
        .tunnels
        .lock()
        .map_err(|_| "Preview tunnel state lock poisoned".to_string())?
        .remove(&id)
        .into_iter()
        .collect();
    close_removed_tunnels(&app, removed);
    Ok(())
}

#[tauri::command]
pub fn preview_terminal_command_started(
    context: PreviewSourceContext,
    provenance: PreviewCommandProvenance,
    preview_state: tauri::State<PreviewWindowState>,
    pty_state: tauri::State<crate::modules::pty::PtyState>,
) -> Result<(), String> {
    if context.transport != "local" {
        return Err("Preview restart provenance requires a local terminal".into());
    }
    let physical_pty_id = validate_terminal_context(&context)?;
    if provenance.generation.is_empty() || provenance.generation.len() > 256 {
        if let Ok(mut commands) = preview_state.terminal_commands.lock() {
            commands.remove(&context.terminal_id);
        }
        return Err("Preview command generation is invalid".into());
    }
    if pty_state.get(physical_pty_id).is_none() {
        return Err("Preview source PTY has exited".into());
    }
    let mut commands = preview_state
        .terminal_commands
        .lock()
        .map_err(|_| "Preview terminal command lock poisoned".to_string())?;
    let fingerprint = command_fingerprint(&provenance.command);
    match commands.get(&context.terminal_id) {
        Some(existing)
            if existing.submitted_at > provenance.submitted_at
                || (existing.submitted_at == provenance.submitted_at
                    && existing.sequence > provenance.sequence) =>
        {
            return Ok(())
        }
        Some(existing)
            if existing.generation == provenance.generation
                && existing.sequence == provenance.sequence
                && existing.submitted_at == provenance.submitted_at
                && existing.command_fingerprint == fingerprint
                && !existing.busy =>
        {
            return Ok(())
        }
        _ => {}
    }
    commands.insert(
        context.terminal_id.clone(),
        terminal_command_runtime(context, provenance, true),
    );
    Ok(())
}

#[tauri::command]
pub fn preview_terminal_command_finished(
    context: PreviewSourceContext,
    provenance: PreviewCommandProvenance,
    preview_state: tauri::State<PreviewWindowState>,
    pty_state: tauri::State<crate::modules::pty::PtyState>,
) -> Result<(), String> {
    if context.transport != "local" {
        return Err("Preview restart provenance requires a local terminal".into());
    }
    let physical_pty_id = validate_terminal_context(&context)?;
    if pty_state.get(physical_pty_id).is_none() {
        return Err("Preview source PTY has exited".into());
    }
    let mut commands = preview_state
        .terminal_commands
        .lock()
        .map_err(|_| "Preview terminal command lock poisoned".to_string())?;
    let fingerprint = command_fingerprint(&provenance.command);
    match commands.get_mut(&context.terminal_id) {
        Some(existing)
            if existing.context == context
                && existing.generation == provenance.generation
                && existing.sequence == provenance.sequence
                && existing.submitted_at == provenance.submitted_at
                && existing.command_fingerprint == fingerprint =>
        {
            existing.busy = false;
            Ok(())
        }
        Some(existing)
            if existing.submitted_at > provenance.submitted_at
                || (existing.submitted_at == provenance.submitted_at
                    && existing.sequence > provenance.sequence) =>
        {
            Ok(())
        }
        Some(_) => Err("Preview command provenance changed".into()),
        None => {
            commands.insert(
                context.terminal_id.clone(),
                terminal_command_runtime(context, provenance, false),
            );
            Ok(())
        }
    }
}

#[tauri::command]
pub fn preview_terminal_exited(
    app: AppHandle,
    context: PreviewSourceContext,
    preview_state: tauri::State<PreviewWindowState>,
) -> Result<(), String> {
    let physical_pty_id = validate_terminal_context(&context)?;
    let mut commands = preview_state
        .terminal_commands
        .lock()
        .map_err(|_| "Preview terminal command lock poisoned".to_string())?;
    if commands
        .get(&context.terminal_id)
        .is_some_and(|existing| existing.context == context)
    {
        commands.remove(&context.terminal_id);
    }
    drop(commands);
    preview_state.close_tunnels_for_pty(&app, physical_pty_id);
    Ok(())
}

#[tauri::command]
pub fn preview_open(app: AppHandle, source: PreviewSource) -> Result<String, String> {
    let (url, origin) = validate_source_with_state(&source, &app.state::<PreviewWindowState>())?;
    let initially_reachable = source_reachable(&url);
    let label = source_label(&source);
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(label);
    }

    let title = format!(
        "Preview · repo={} · worktree={} · session={} · terminal={} · remote={} · local={}",
        source.repository_id,
        source.worktree_id,
        source.session_id,
        source.terminal_id,
        source
            .remote_source_url
            .as_deref()
            .map(safe_source_url)
            .unwrap_or_else(|| "local".into()),
        safe_source_url(&source.source_url)
    );
    let window_generation = app.state::<PreviewWindowState>().next_generation()?;
    let mut runtime_source = source.clone();
    if runtime_source
        .restart_provenance
        .as_ref()
        .is_some_and(|provenance| validate_restart_command(&provenance.command).is_err())
    {
        runtime_source.restart_provenance = None;
    }
    let nonce = telemetry_nonce()?;
    let telemetry_script = telemetry_script(&nonce);
    app.state::<PreviewWindowState>()
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .insert(
            label.clone(),
            PreviewRuntimeEntry {
                source: runtime_source,
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
    let tunnel_id_for_close = source.tunnel_id.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app_for_close.state::<PreviewWindowState>();
            if let Ok(mut entries) = state.entries.lock() {
                if entries
                    .get(&label_for_close)
                    .is_some_and(|entry| entry.window_generation == window_generation)
                {
                    entries.remove(&label_for_close);
                }
            }
            if let Some(tunnel_id) = tunnel_id_for_close.as_deref() {
                if let Ok(mut tunnels) = state.tunnels.lock() {
                    if let Some(runtime) = tunnels.remove(tunnel_id) {
                        if let Some(cancel) = runtime.cancel {
                            let _ = cancel.send(true);
                        }
                    }
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
    let (url, _) = validate_source_with_state(&source, &app.state::<PreviewWindowState>())?;
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
    pty_state: tauri::State<crate::modules::pty::PtyState>,
) -> Result<Option<PreviewRuntimeState>, String> {
    validate_source_identity(&source)?;
    let label = source_label(&source);
    let state = app.state::<PreviewWindowState>();
    let status = {
        let mut entries = state
            .entries
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        let Some(entry) = entries.get_mut(&label) else {
            return Ok(None);
        };
        let commands = state
            .terminal_commands
            .lock()
            .map_err(|_| "Preview terminal command lock poisoned".to_string())?;
        if entry.source.restart_provenance != source.restart_provenance
            && validate_source_with_state(&source, &state).is_ok()
            && command_proves_source_generation(&source, &commands)
        {
            entry.source.restart_provenance = source.restart_provenance.clone();
        }
        Some((
            entry.status,
            entry.viewport_mode.clone(),
            entry.requested_viewport,
            telemetry_summary(entry),
            restart_summary(entry, &source, &commands, &pty_state),
        ))
    };
    let Some((status, viewport_mode, requested_viewport, telemetry, restart)) = status else {
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
        restart,
    }))
}

fn preview_window(
    app: &AppHandle,
    source: &PreviewSource,
) -> Result<(String, u64, tauri::WebviewWindow), String> {
    validate_source_with_state(source, &app.state::<PreviewWindowState>())?;
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

#[cfg(target_os = "macos")]
async fn native_css_viewport(window: &tauri::WebviewWindow) -> Result<(u32, u32), String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSString};

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(Mutex::new(Some(sender)));
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            let sender = sender.clone();
            let completion = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() || value.is_null() {
                    Err("Preview CSS viewport query failed".to_string())
                } else {
                    let encoded = (&*value.cast::<NSString>()).to_string();
                    encoded
                        .split_once('x')
                        .and_then(|(width, height)| {
                            Some((width.parse::<u32>().ok()?, height.parse::<u32>().ok()?))
                        })
                        .filter(|(width, height)| *width > 0 && *height > 0)
                        .ok_or_else(|| {
                            "Preview CSS viewport query returned invalid data".to_string()
                        })
                };
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            });
            let script = NSString::from_str("`${window.innerWidth}x${window.innerHeight}`");
            view.evaluateJavaScript_completionHandler(&script, Some(&completion));
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(CAPTURE_TIMEOUT, receiver)
        .await
        .map_err(|_| "Preview CSS viewport query timed out".to_string())?
        .map_err(|_| "Preview CSS viewport query callback closed".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn native_css_viewport(window: &tauri::WebviewWindow) -> Result<(u32, u32), String> {
    logical_webview_size(window)
}

#[cfg(target_os = "macos")]
async fn native_capture_png(window: &tauri::WebviewWindow) -> Result<(Vec<u8>, u32, u32), String> {
    use block2::RcBlock;
    use objc2::MainThreadOnly;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKSnapshotConfiguration;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(Mutex::new(Some(sender)));
    window
        .with_webview(move |webview| unsafe {
            let view: &objc2_web_kit::WKWebView = &*webview.inner().cast();
            let safe = view.safeAreaInsets();
            let mut rect = view.bounds();
            rect.origin.x += safe.left;
            rect.origin.y += safe.top;
            rect.size.width = (rect.size.width - safe.left - safe.right).max(0.0);
            rect.size.height = (rect.size.height - safe.top - safe.bottom).max(0.0);
            let configuration = WKSnapshotConfiguration::new(view.mtm());
            configuration.setRect(rect);
            let sender = sender.clone();
            let completion = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let result = if image.is_null() {
                    Err("Preview WKWebView snapshot failed".to_string())
                } else {
                    let image = &*image;
                    image
                        .TIFFRepresentation()
                        .ok_or_else(|| "Preview snapshot has no image representation".to_string())
                        .and_then(|tiff| {
                            NSBitmapImageRep::imageRepWithData(&tiff).ok_or_else(|| {
                                "Preview snapshot bitmap conversion failed".to_string()
                            })
                        })
                        .and_then(|bitmap| {
                            let properties = NSDictionary::new();
                            bitmap
                                .representationUsingType_properties(
                                    NSBitmapImageFileType::PNG,
                                    &properties,
                                )
                                .ok_or_else(|| "Preview snapshot PNG encoding failed".to_string())
                                .map(|png| {
                                    (
                                        png.to_vec(),
                                        bitmap.pixelsWide().max(0) as u32,
                                        bitmap.pixelsHigh().max(0) as u32,
                                    )
                                })
                        })
                };
                if let Ok(mut sender) = sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(result);
                    }
                }
            });
            view.takeSnapshotWithConfiguration_completionHandler(Some(&configuration), &completion);
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(CAPTURE_TIMEOUT, receiver)
        .await
        .map_err(|_| "Preview WKWebView snapshot timed out".to_string())?
        .map_err(|_| "Preview WKWebView snapshot callback closed".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn native_capture_png(_window: &tauri::WebviewWindow) -> Result<(Vec<u8>, u32, u32), String> {
    Err("Native Preview capture is unavailable on this platform".into())
}

#[tauri::command]
pub async fn preview_capture(
    app: AppHandle,
    source: PreviewSource,
    options: PreviewCaptureOptions,
) -> Result<PreviewCaptureResult, String> {
    let format = validate_capture_format(&options.format)?;
    let (label, generation, window) = preview_window(&app, &source)?;
    let (status, requested_viewport) = {
        let state = app.state::<PreviewWindowState>();
        let entries = state
            .entries
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        let entry = entries
            .get(&label)
            .ok_or_else(|| "Preview source is not open".to_string())?;
        (entry.status, entry.requested_viewport)
    };
    if status != PreviewRuntimeStatus::Ready {
        return Err("Preview must be ready before capture".into());
    }
    if u64::from(requested_viewport.0).saturating_mul(u64::from(requested_viewport.1))
        > MAX_CAPTURE_PIXELS
    {
        return Err("Preview viewport exceeds the capture safety limit".into());
    }

    let current_url = window.url().map_err(|error| error.to_string())?;
    let viewport = native_css_viewport(&window).await?;
    let zoom_factor = native_zoom(&window)?;
    let (png, image_width, image_height) = native_capture_png(&window).await?;
    validate_capture_size(image_width, image_height, png.len())?;

    let still_current = {
        let state = app.state::<PreviewWindowState>();
        let entries = state
            .entries
            .lock()
            .map_err(|_| "Preview state lock poisoned".to_string())?;
        entries.get(&label).is_some_and(|entry| {
            entry.window_generation == generation && entry.status == PreviewRuntimeStatus::Ready
        })
    };
    if !still_current
        || app.get_webview_window(&label).is_none()
        || window.url().map_err(|error| error.to_string())? != current_url
        || native_css_viewport(&window).await? != viewport
        || (native_zoom(&window)? - zoom_factor).abs() > 0.001
    {
        return Err("Preview source changed during capture".into());
    }

    let captured_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before Unix epoch".to_string())?
        .as_millis() as u64;
    let sequence = app.state::<PreviewWindowState>().next_capture_sequence()?;
    let capture_id = format!(
        "capture-{}",
        &sha256_hex(format!(
            "{label}\0{generation}\0{sequence}\0{captured_at_ms}"
        ))[..24]
    );
    let directory = capture_directory(&app)?;
    let image_path = directory.join(format!("{capture_id}.png"));
    let local_ref = safe_local_ref(&image_path, &capture_id);
    let source_metadata = capture_source_metadata(&source, &current_url)?;
    let source_summary = capture_source_summary(&source_metadata);
    let image_sha256 = sha256_hex(&png);
    let metadata = PreviewCaptureMetadata {
        schema_version: 1,
        capture_id: capture_id.clone(),
        local_ref: local_ref.clone(),
        source: source_metadata.clone(),
        captured_at_ms,
        viewport_css: PreviewCaptureViewportMetadata {
            width: viewport.0,
            height: viewport.1,
        },
        zoom_factor,
        window_generation: generation,
        image: PreviewCaptureImageMetadata {
            format: format.into(),
            width: image_width,
            height: image_height,
            byte_size: png.len(),
            sha256: image_sha256.clone(),
        },
    };
    let _ = write_capture_artifacts(&directory, &capture_id, &png, &metadata)?;

    let record = PreviewCaptureRecord {
        source_label: label,
        window_generation: generation,
        captured_at_ms,
        local_ref: local_ref.clone(),
        source_origin: source_metadata.source_origin.clone(),
        source_summary: source_summary.clone(),
        terminal_ref: source_metadata.terminal_ref.clone(),
    };
    let prepared_text = capture_prepared_text(&record);
    let state = app.state::<PreviewWindowState>();
    let mut captures = state
        .captures
        .lock()
        .map_err(|_| "Preview capture state lock poisoned".to_string())?;
    if captures.len() >= MAX_RUNTIME_CAPTURES {
        if let Some(oldest) = captures
            .iter()
            .min_by_key(|(_, record)| record.captured_at_ms)
            .map(|(id, _)| id.clone())
        {
            captures.remove(&oldest);
        }
    }
    captures.insert(capture_id.clone(), record);

    Ok(PreviewCaptureResult {
        capture_id,
        local_ref,
        source_origin: source_metadata.source_origin,
        source_summary,
        prepared_text,
        captured_at_ms,
        viewport_css_width: viewport.0,
        viewport_css_height: viewport.1,
        zoom_factor,
        window_generation: generation,
        image_format: format.into(),
        image_width,
        image_height,
        image_sha256,
    })
}

#[tauri::command]
pub fn preview_send_capture_to_source_terminal(
    app: AppHandle,
    pty_state: tauri::State<PtyState>,
    source: PreviewSource,
    capture_id: String,
) -> Result<PreviewSendReceipt, String> {
    validate_source(&source)?;
    let expected_physical = source
        .physical_pty_id
        .ok_or_else(|| "Preview source has no live physical PTY".to_string())?;
    if pty_state.physical_for_logical(&source.session_id) != Some(expected_physical) {
        return Err("Preview source PTY generation is no longer current".into());
    }
    let label = source_label(&source);
    let record = app
        .state::<PreviewWindowState>()
        .captures
        .lock()
        .map_err(|_| "Preview capture state lock poisoned".to_string())?
        .get(&capture_id)
        .cloned()
        .ok_or_else(|| "Preview capture reference is unavailable".to_string())?;
    if record.source_label != label {
        return Err("Preview capture belongs to a different source".into());
    }
    let current_generation = app
        .state::<PreviewWindowState>()
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .get(&label)
        .and_then(|entry| {
            (entry.status == PreviewRuntimeStatus::Ready).then_some(entry.window_generation)
        });
    if current_generation != Some(record.window_generation) {
        return Err("Preview capture window generation is stale".into());
    }
    let text = capture_prepared_text(&record);
    if text.contains(['\r', '\n']) {
        return Err("Preview prepared text contains an execution boundary".into());
    }
    let session = pty_state
        .get(expected_physical)
        .ok_or_else(|| "Preview source PTY is no longer available".to_string())?;
    session.write(text.as_bytes())?;
    Ok(PreviewSendReceipt {
        terminal_ref: record.terminal_ref,
        bytes_written: text.len(),
        executed: false,
    })
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
    let (source_url, _) = validate_source_with_state(&source, &app.state::<PreviewWindowState>())?;
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
    validate_source_with_state(&source, &app.state::<PreviewWindowState>())?;
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
    validate_source_with_state(&source, &state)?;
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
    validate_source_with_state(&source, &preview_state)?;
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
pub fn preview_restart_prepare(
    source: PreviewSource,
    preview_state: tauri::State<PreviewWindowState>,
    pty_state: tauri::State<crate::modules::pty::PtyState>,
) -> Result<(), String> {
    validate_source_with_state(&source, &preview_state)?;
    if source.transport != "local" {
        return Err("Preview restart preparation is unavailable for SSH forwarded sources".into());
    }
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
    let mut commands = preview_state
        .terminal_commands
        .lock()
        .map_err(|_| "Preview terminal command lock poisoned".to_string())?;
    let eligibility = restart_summary(entry, &source, &commands, &pty_state);
    if !eligibility.eligible {
        return Err(format!(
            "Preview restart is unavailable: {}",
            eligibility.reason
        ));
    }
    let command = eligibility
        .command
        .ok_or_else(|| "Preview restart command is unavailable".to_string())?;
    let runtime = commands
        .get_mut(&source.terminal_id)
        .ok_or_else(|| "Preview restart provenance disappeared".to_string())?;
    let session = pty_state
        .get(physical_pty_id)
        .ok_or_else(|| "Preview source PTY has exited".to_string())?;
    session.write(command.as_bytes())?;
    runtime.prepared = true;
    Ok(())
}

#[tauri::command]
pub fn preview_close(app: AppHandle, source: PreviewSource) -> Result<(), String> {
    validate_source_identity(&source)?;
    let label = source_label(&source);
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|error| error.to_string())?;
    }
    let state = app.state::<PreviewWindowState>();
    state
        .entries
        .lock()
        .map_err(|_| "Preview state lock poisoned".to_string())?
        .remove(&label);
    if let Some(tunnel_id) = source.tunnel_id.as_deref() {
        if let Some(runtime) = state
            .tunnels
            .lock()
            .map_err(|_| "Preview tunnel state lock poisoned".to_string())?
            .remove(tunnel_id)
        {
            if let Some(cancel) = runtime.cancel {
                let _ = cancel.send(true);
            }
        }
    }
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
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            remote_source_url: None,
            tunnel_id: None,
            restart_provenance: None,
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

    fn context(terminal_id: &str, physical_pty_id: u32) -> PreviewSourceContext {
        PreviewSourceContext {
            repository_id: "repo-a".into(),
            worktree_id: "worktree-a".into(),
            workspace_id: "repo-a::worktree-a".into(),
            session_id: "session-a".into(),
            terminal_id: terminal_id.into(),
            physical_pty_id: Some(physical_pty_id),
            transport: "local".into(),
            workspace_resolution: "resolved".into(),
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
        }
    }

    fn provenance(sequence: u64, command: &str) -> PreviewCommandProvenance {
        PreviewCommandProvenance {
            generation: format!("session-a:0:{sequence}"),
            sequence,
            command: command.into(),
            submitted_at: 100 + sequence,
        }
    }

    fn remote_source(url: &str) -> PreviewSource {
        PreviewSource {
            source_url: url.into(),
            transport: "ssh".into(),
            permission: "remote-manual".into(),
            ssh_host: Some("dev.example".into()),
            ssh_port: Some(22),
            ssh_user: Some("mawei".into()),
            ..source("http://localhost:4173/")
        }
    }

    #[test]
    fn tunnel_accepts_only_exact_remote_loopback_sources_and_effective_ports() {
        for (url, host, port) in [
            ("http://localhost/", "localhost", 80),
            ("https://127.0.0.1/", "127.0.0.1", 443),
            ("http://[::1]:4173/app", "::1", 4173),
        ] {
            let (_, actual_host, actual_port) =
                validate_remote_tunnel_source(&remote_source(url)).unwrap();
            assert_eq!((actual_host.as_str(), actual_port), (host, port));
        }
        for url in [
            "http://user:pass@localhost:4173/",
            "http://0.0.0.0:4173/",
            "https://example.com/",
            "file:///tmp/secret",
            "http://localhost:0/",
            "http://localhost:65536/",
        ] {
            assert!(
                validate_remote_tunnel_source(&remote_source(url)).is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn tunnel_nonce_is_single_shape_and_derived_endpoint_preserves_remote_identity() {
        assert!(tunnel_nonce_is_valid(&"a1".repeat(32)));
        assert!(!tunnel_nonce_is_valid("old-generation"));
        assert!(!tunnel_nonce_is_valid(&"g".repeat(64)));
        let original = remote_source("http://[::1]:4173/app?q=1#two");
        let derived = derived_forwarded_source(&original, &"b".repeat(64), 53124).unwrap();
        assert_eq!(derived.source_url, "http://127.0.0.1:53124/app?q=1#two");
        assert_eq!(
            derived.remote_source_url.as_deref(),
            Some(original.source_url.as_str())
        );
        assert_eq!(derived.permission, "forwarded");
        assert_eq!(derived.ssh_host, original.ssh_host);
        assert_eq!(derived.physical_pty_id, original.physical_pty_id);
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
        second = first.clone();
        second.physical_pty_id = Some(8);
        assert_ne!(source_label(&first), source_label(&second));
    }

    #[test]
    fn restart_accepts_only_narrow_single_service_start_commands() {
        for command in [
            "npm run dev",
            "npm start -- --port=4173",
            "pnpm dev --host 127.0.0.1",
            "yarn run preview",
            "bun run serve",
            "python3 -m http.server 4173 --bind 127.0.0.1",
            "vite --port 4173",
            "next dev",
            "astro dev",
            "ng serve",
            "deno task dev",
        ] {
            assert_eq!(validate_restart_command(command).unwrap(), command);
        }
    }

    #[test]
    fn restart_rejects_controls_length_compound_subshell_redirection_pipe_and_dangerous_commands() {
        let control = format!("pnpm dev{}", char::from(7));
        let oversized = format!("pnpm dev {}", "x".repeat(RESTART_COMMAND_MAX_BYTES));
        for command in [
            "pnpm dev\r",
            "pnpm dev\n",
            control.as_str(),
            oversized.as_str(),
            "pnpm dev && echo owned",
            "pnpm dev; echo owned",
            "pnpm dev | tee output",
            "pnpm dev > output.log",
            "pnpm dev < input",
            "pnpm $(echo dev)",
            "pnpm `echo dev`",
            "rm -rf /",
            "sudo npm run dev",
            "npx vite",
            "node server.js",
            "PORT=4173 pnpm dev",
        ] {
            assert!(
                validate_restart_command(command).is_err(),
                "accepted {command:?}"
            );
        }
    }

    #[test]
    fn unsafe_or_newer_terminal_commands_invalidate_old_restart_provenance_without_storing_text() {
        let safe =
            terminal_command_runtime(context("session-a:0", 7), provenance(1, "pnpm dev"), false);
        assert_eq!(safe.restart_command.as_deref(), Some("pnpm dev"));
        assert!(!safe.busy);

        let unsafe_command = "rm -rf /tmp/example";
        let unsafe_runtime = terminal_command_runtime(
            context("session-a:0", 7),
            provenance(2, unsafe_command),
            true,
        );
        assert_eq!(unsafe_runtime.restart_command, None);
        assert!(unsafe_runtime.busy);
        assert!(!unsafe_runtime.command_fingerprint.contains(unsafe_command));
        assert!(unsafe_runtime.sequence > safe.sequence);

        let other_worktree = terminal_command_runtime(
            PreviewSourceContext {
                worktree_id: "worktree-b".into(),
                workspace_id: "repo-a::worktree-b".into(),
                ..context("session-a:0", 8)
            },
            provenance(3, "pnpm dev"),
            false,
        );
        assert_ne!(safe.context, other_worktree.context);
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

    #[test]
    fn capture_accepts_only_png_and_bounded_nonempty_images() {
        assert_eq!(validate_capture_format("png").unwrap(), "png");
        assert_eq!(validate_capture_format("PNG").unwrap(), "png");
        for format in ["jpg", "jpeg", "webp", "pdf", "", "../png"] {
            assert!(validate_capture_format(format).is_err());
        }
        assert!(validate_capture_size(980, 720, 1024).is_ok());
        assert!(validate_capture_size(0, 720, 1024).is_err());
        assert!(validate_capture_size(980, 0, 1024).is_err());
        assert!(validate_capture_size(5000, 5000, 1024).is_err());
        assert!(validate_capture_size(980, 720, 0).is_err());
        assert!(validate_capture_size(980, 720, MAX_CAPTURE_BYTES + 1).is_err());
    }

    #[test]
    fn capture_metadata_and_prepared_text_redact_raw_identity_and_url_secrets() {
        let source = source("http://127.0.0.1:4173/private/path?token=secret#account");
        let url = source.source_url.parse::<tauri::Url>().unwrap();
        let safe = capture_source_metadata(&source, &url).unwrap();
        let record = PreviewCaptureRecord {
            source_label: source_label(&source),
            window_generation: 9,
            captured_at_ms: 10,
            local_ref: "$HOME/Library/Caches/test/preview-evidence/capture-safe.png".into(),
            source_origin: safe.source_origin.clone(),
            source_summary: capture_source_summary(&safe),
            terminal_ref: safe.terminal_ref.clone(),
        };
        let serialized = serde_json::to_string(&safe).unwrap();
        let prepared = capture_prepared_text(&record);
        for secret in [
            "repo-a",
            "worktree-a",
            "session-a",
            "private/path",
            "token",
            "secret",
            "account",
        ] {
            assert!(!serialized.contains(secret), "metadata leaked {secret}");
            assert!(!prepared.contains(secret), "prepared text leaked {secret}");
        }
        assert!(serialized.contains("http://127.0.0.1:4173"));
        assert!(!prepared.contains('\n'));
        assert!(!prepared.contains('\r'));
    }

    #[test]
    fn capture_records_remain_bound_to_source_and_window_generation() {
        let first = source("http://127.0.0.1:4173/");
        let mut other_worktree = first.clone();
        other_worktree.worktree_id = "worktree-b".into();
        other_worktree.workspace_id = "repo-a::worktree-b".into();
        let record = PreviewCaptureRecord {
            source_label: source_label(&first),
            window_generation: 3,
            captured_at_ms: 1,
            local_ref: "preview-evidence://capture-safe".into(),
            source_origin: "http://127.0.0.1:4173".into(),
            source_summary: "redacted".into(),
            terminal_ref: "terminal-sha256:abc".into(),
        };
        assert_eq!(record.source_label, source_label(&first));
        assert_ne!(record.source_label, source_label(&other_worktree));
        assert_ne!(record.window_generation, 4);
    }
}
