//! Independent SSH local-forward registry.
//!
//! Limits are deliberately small and explicit: at most 16 rules per SSH
//! session and 32 concurrent relays per rule. A rule owns the exact `Arc` PTY
//! generation on which it was created and disappears when that generation is
//! closed/replaced.

use super::diagnostics::SessionBindingV1;
use crate::modules::pty::{PtyState, Session};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

pub const MAX_RULES_PER_SESSION: usize = 16;
pub const MAX_CONNECTIONS_PER_RULE: usize = 32;
const SOCKS_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const RECONNECT_SNAPSHOT_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

fn can_accept_connection(active: usize) -> bool {
    active < MAX_CONNECTIONS_PER_RULE
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalForwardView {
    pub rule_id: String,
    pub binding: SessionBindingV1,
    pub bind_host: String,
    pub local_port: u16,
    pub requested_local_port: u16,
    pub recreate_on_reconnect: bool,
    pub target_host: String,
    pub target_port: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicForwardView {
    pub rule_id: String,
    pub binding: SessionBindingV1,
    pub bind_host: String,
    pub local_port: u16,
    pub requested_local_port: u16,
    pub recreate_on_reconnect: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteForwardView {
    pub rule_id: String,
    pub binding: SessionBindingV1,
    pub remote_bind_host: String,
    pub remote_port: u16,
    pub requested_remote_port: u16,
    pub recreate_on_reconnect: bool,
    pub local_target_host: String,
    pub local_target_port: u16,
}

/// A deliberately narrow, serializable reconnect intent. The old rule id and
/// binding let rebuild stop only the rule represented by this snapshot.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardReconnectIntent {
    Local {
        old_rule_id: String,
        old_binding: SessionBindingV1,
        bind_host: String,
        requested_local_port: u16,
        old_actual_local_port: u16,
        target_host: String,
        target_port: u16,
    },
    Dynamic {
        old_rule_id: String,
        old_binding: SessionBindingV1,
        bind_host: String,
        requested_local_port: u16,
        old_actual_local_port: u16,
    },
    Remote {
        old_rule_id: String,
        old_binding: SessionBindingV1,
        remote_bind_host: String,
        requested_remote_port: u16,
        old_actual_remote_port: u16,
        local_target_host: String,
        local_target_port: u16,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardRebuildFailure {
    FixedPortUnavailable,
    StaleBinding,
    LimitExceeded,
    InvalidIntent,
    Internal,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRebuildResult {
    pub old_rule_id: String,
    pub old_actual_local_port: u16,
    pub requested_local_port: u16,
    pub new_actual_local_port: Option<u16>,
    pub new_rule_id: Option<String>,
    pub failure: Option<ForwardRebuildFailure>,
}

#[derive(Clone)]
enum RuleView {
    Local(LocalForwardView),
    Dynamic(DynamicForwardView),
    Remote(RemoteForwardView),
}

impl RuleView {
    fn binding(&self) -> &SessionBindingV1 {
        match self {
            Self::Local(view) => &view.binding,
            Self::Dynamic(view) => &view.binding,
            Self::Remote(view) => &view.binding,
        }
    }
}

struct Rule {
    view: RuleView,
    generation: Arc<Session>,
    cancel: watch::Sender<bool>,
    completed: watch::Receiver<bool>,
}

async fn stop_rule(cancel: watch::Sender<bool>, mut completed: watch::Receiver<bool>) {
    let started = Instant::now();
    let _ = cancel.send(true);
    if !*completed.borrow() {
        let _ = completed.changed().await;
    }
    crate::modules::perf_counters::cancel_latency(
        started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
    );
}

#[derive(Clone, Copy)]
enum RuleKind {
    Local,
    Dynamic,
    Remote,
}

/// Validate the complete backend-issued binding and signal one matching rule
/// while a binding lease prevents replacement from interleaving between the
/// final validation and cancellation. A stale stop therefore has no registry
/// or listener side effects.
fn cancel_bound_rule(
    pty: &PtyState,
    state: &ForwardingState,
    binding: &SessionBindingV1,
    rule_id: &str,
    kind: RuleKind,
) -> Result<(watch::Receiver<bool>, Instant), String> {
    valid_token(&binding.logical_session_id, "binding.logicalSessionId")?;
    valid_token(&binding.transport_generation, "binding.transportGeneration")?;
    valid_token(rule_id, "ruleId")?;

    let authoritative = pty
        .get_for_ssh_binding(binding)
        .ok_or("SSH session binding is stale")?;
    let binding_lease = pty.acquire_commit_lease(binding)?;
    let current = pty
        .get_for_ssh_binding(binding)
        .filter(|current| Arc::ptr_eq(current, &authoritative))
        .ok_or("SSH session binding is stale")?;

    let completed = {
        let rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        let rule = rules.get(rule_id).ok_or("forward rule not found")?;
        let matching_kind = matches!(
            (&rule.view, kind),
            (RuleView::Local(_), RuleKind::Local)
                | (RuleView::Dynamic(_), RuleKind::Dynamic)
                | (RuleView::Remote(_), RuleKind::Remote)
        );
        if !matching_kind
            || rule.view.binding() != binding
            || !Arc::ptr_eq(&rule.generation, &current)
        {
            return Err("forward rule does not belong to this SSH binding".into());
        }
        let started = Instant::now();
        let _ = rule.cancel.send(true);
        (rule.completed.clone(), started)
    };
    drop(binding_lease);
    Ok(completed)
}

async fn wait_for_rule_stop(mut completed: watch::Receiver<bool>, started: Instant) {
    if !*completed.borrow() {
        let _ = completed.changed().await;
    }
    crate::modules::perf_counters::cancel_latency(
        started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64,
    );
}

/// Wait for the exact binding to retire. A dropped sender is terminal too: the
/// binding entry can no longer prove that this rule belongs to a live session.
async fn wait_for_binding_retirement(retired: &mut watch::Receiver<bool>) {
    if *retired.borrow_and_update() {
        return;
    }
    let _ = retired.changed().await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuleExit {
    Cancelled,
    TransportClosed,
    BindingRetired,
    ListenerClosed,
}

fn preserve_reconnect_snapshot(exit: RuleExit, transport_lost: bool) -> bool {
    matches!(exit, RuleExit::TransportClosed | RuleExit::BindingRetired) && transport_lost
}

async fn finish_relays(relays: &mut tokio::task::JoinSet<Result<(), String>>) {
    while relays.join_next().await.is_some() {}
}

fn cleanup_rule_registration(
    app: AppHandle,
    rule_id: String,
    generation: Arc<Session>,
    preserve_for_snapshot: bool,
) {
    let remove = move || {
        if let Ok(mut rules) = app.state::<ForwardingState>().rules.lock() {
            if rules
                .get(&rule_id)
                .is_some_and(|rule| Arc::ptr_eq(&rule.generation, &generation))
            {
                rules.remove(&rule_id);
            }
        }
    };
    if preserve_for_snapshot {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(RECONNECT_SNAPSHOT_GRACE).await;
            remove();
        });
    } else {
        remove();
    }
}

#[derive(Default)]
pub struct ForwardingState {
    rules: Mutex<HashMap<String, Rule>>,
    next_id: AtomicU64,
}

impl ForwardingState {
    pub fn close_all(&self) {
        if let Ok(mut rules) = self.rules.lock() {
            for (_, rule) in rules.drain() {
                let _ = rule.cancel.send(true);
            }
        }
    }
}

fn valid_token(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        Err(format!(
            "{label} must be 1..255 characters without whitespace"
        ))
    } else {
        Ok(())
    }
}

fn parse_bind(host: &str) -> Result<IpAddr, String> {
    match host.parse::<IpAddr>() {
        Ok(ip)
            if ip == IpAddr::from([127, 0, 0, 1])
                || ip == IpAddr::from([0, 0, 0, 0, 0, 0, 0, 1]) =>
        {
            Ok(ip)
        }
        _ => Err("bindHost must be exactly 127.0.0.1 or ::1".into()),
    }
}

fn ssh_generation(
    pty: &PtyState,
    binding: &SessionBindingV1,
) -> Result<(u32, Arc<Session>), String> {
    valid_token(&binding.logical_session_id, "binding.logicalSessionId")?;
    valid_token(&binding.transport_generation, "binding.transportGeneration")?;
    let physical_id = binding.physical_pty_id;
    let generation = pty
        .get_for_ssh_binding(binding)
        .ok_or("SSH session binding is stale")?;
    if !matches!(generation.as_ref(), Session::Ssh(_)) {
        return Err("binding does not identify an SSH session".into());
    }
    Ok((physical_id, generation))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_local_forward_start(
    app: AppHandle,
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
    bind_host: String,
    local_port: u16,
    target_host: String,
    target_port: u16,
    recreate_on_reconnect: Option<bool>,
) -> Result<LocalForwardView, String> {
    (async {
    let bind_ip = parse_bind(&bind_host)?;
    valid_token(&target_host, "targetHost")?;
    if target_port == 0 {
        return Err("targetPort must be non-zero".into());
    }
    let mut binding_retired = pty.subscribe_binding_retired(&binding)?;
    let (physical_id, generation) = ssh_generation(&pty, &binding)?;
    if matches!(generation.as_ref(), Session::Ssh(ssh) if ssh.transport_lost()) {
        return Err("SSH session binding is stale".into());
    }
    {
        let rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        if rules
            .values()
            .filter(|r| r.view.binding().logical_session_id == binding.logical_session_id)
            .count()
            >= MAX_RULES_PER_SESSION
        {
            return Err(format!(
                "session local-forward limit ({MAX_RULES_PER_SESSION}) reached"
            ));
        }
    }

    // Binding, including port zero allocation, is one atomic OS operation. No
    // target probe is made; each accepted stream opens its own direct-tcpip.
    let listener = TcpListener::bind((bind_ip, local_port))
        .await
        .map_err(|e| format!("cannot bind local forward: {e}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("cannot read local forward address: {e}"))?
        .port();
    let binding_lease = pty.acquire_commit_lease(&binding)?;
    let (physical_after, generation_after) = ssh_generation(&pty, &binding)?;
    if physical_after != physical_id
        || !Arc::ptr_eq(&generation, &generation_after)
        || *binding_retired.borrow()
        || matches!(generation_after.as_ref(), Session::Ssh(ssh) if ssh.transport_lost())
    {
        return Err("SSH session generation changed while starting forward".into());
    }
    let rule_id = format!("lf-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let view = LocalForwardView {
        rule_id: rule_id.clone(),
        binding: binding.clone(),
        bind_host,
        local_port: actual_port,
        requested_local_port: local_port,
        recreate_on_reconnect: recreate_on_reconnect.unwrap_or(false),
        target_host: target_host.clone(),
        target_port,
    };
    let (cancel, mut cancelled) = watch::channel(false);
    let (completion_tx, completion_rx) = watch::channel(false);
    {
        let mut rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        if rules
            .values()
            .filter(|r| r.view.binding().logical_session_id == binding.logical_session_id)
            .count()
            >= MAX_RULES_PER_SESSION
        {
            return Err(format!(
                "session local-forward limit ({MAX_RULES_PER_SESSION}) reached"
            ));
        }
        rules.insert(
            rule_id.clone(),
            Rule {
                view: RuleView::Local(view.clone()),
                generation: generation.clone(),
                cancel: cancel.clone(),
                completed: completion_rx,
            },
        );
    }
    if !ssh_generation(&pty, &binding).is_ok_and(|(_, current)| {
        Arc::ptr_eq(&current, &generation)
            && matches!(current.as_ref(), Session::Ssh(ssh) if !ssh.transport_lost())
    }) || *binding_retired.borrow()
    {
        if let Ok(mut rules) = state.rules.lock() {
            rules.remove(&rule_id);
        }
        let _ = cancel.send(true);
        return Err("SSH session generation changed while registering forward".into());
    }
    drop(binding_lease);

    let preserve_for_snapshot = view.recreate_on_reconnect;
    tokio::spawn(async move {
        let mut relays = tokio::task::JoinSet::new();
        let Session::Ssh(ssh) = generation.as_ref() else {
            let _ = cancel.send(true);
            cleanup_rule_registration(app, rule_id, generation, false);
            let _ = completion_tx.send(true);
            return;
        };
        let exit = loop {
            tokio::select! {
                biased;
                _ = cancelled.changed() => break RuleExit::Cancelled,
                _ = ssh.wait_closed() => break RuleExit::TransportClosed,
                _ = wait_for_binding_retirement(&mut binding_retired) => break RuleExit::BindingRetired,
                accepted = listener.accept(), if can_accept_connection(relays.len()) => match accepted {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        if *cancelled.borrow() { break RuleExit::Cancelled; }
                        let pty = app.state::<PtyState>();
                        let current = pty.get_for_ssh_binding(&binding);
                        if current.as_ref().is_none_or(|s| !Arc::ptr_eq(s, &generation)) {
                            break RuleExit::BindingRetired;
                        }
                        let generation = generation.clone();
                        let host = target_host.clone();
                        let relay_cancelled = cancelled.clone();
                        relays.spawn(async move {
                            let Session::Ssh(ssh) = generation.as_ref() else { return Err("SSH generation changed".into()) };
                            super::direct_tcpip::relay(ssh, stream, &host, target_port, relay_cancelled).await
                        });
                    }
                    Ok(_) => {},
                    Err(_) => break RuleExit::ListenerClosed,
                },
                _ = relays.join_next(), if !relays.is_empty() => {},
            }
        };
        let transport_lost = ssh.transport_lost();
        drop(listener);
        let _ = cancel.send(true);
        finish_relays(&mut relays).await;
        cleanup_rule_registration(
            app,
            rule_id,
            generation,
            preserve_for_snapshot && preserve_reconnect_snapshot(exit, transport_lost),
        );
        let _ = completion_tx.send(true);
    });
    Ok(view)

    }).await.map_err(|error: String| crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error))
}

#[tauri::command]
pub fn ssh_local_forward_list(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: Option<SessionBindingV1>,
) -> Result<Vec<LocalForwardView>, String> {
    (|| {
        if let Some(binding) = binding.as_ref() {
            valid_token(&binding.logical_session_id, "binding.logicalSessionId")?;
            valid_token(&binding.transport_generation, "binding.transportGeneration")?;
        }
        let mut rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        rules.retain(|_, rule| {
            let current = pty.get_for_ssh_binding(rule.view.binding());
            let valid = current.is_some_and(|current| Arc::ptr_eq(&current, &rule.generation));
            if !valid {
                let _ = rule.cancel.send(true);
            }
            valid
        });
        let mut views: Vec<_> = rules
            .values()
            .filter(|r| {
                binding
                    .as_ref()
                    .is_none_or(|binding| r.view.binding() == binding)
            })
            .filter_map(|r| match &r.view {
                RuleView::Local(view) => Some(view.clone()),
                RuleView::Dynamic(_) | RuleView::Remote(_) => None,
            })
            .collect();
        views.sort_by(|a, b| a.rule_id.cmp(&b.rule_id));
        Ok(views)
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[tauri::command]
pub async fn ssh_local_forward_stop(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
    rule_id: String,
) -> Result<(), String> {
    (async {
        let (completed, started) =
            cancel_bound_rule(&pty, &state, &binding, &rule_id, RuleKind::Local)?;
        wait_for_rule_stop(completed, started).await;
        Ok(())
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[derive(Debug, PartialEq, Eq)]
struct SocksTarget {
    host: String,
    port: u16,
}

async fn socks_reply<W: AsyncWrite + Unpin>(w: &mut W, rep: u8) -> Result<(), String> {
    w.write_all(&[5, rep, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| e.to_string())
}

async fn parse_socks5<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Result<SocksTarget, String> {
    let mut greeting = [0; 2];
    s.read_exact(&mut greeting)
        .await
        .map_err(|e| e.to_string())?;
    if greeting[0] != 5 {
        return Err("invalid SOCKS5 greeting version".into());
    }
    if greeting[1] == 0 {
        s.write_all(&[5, 0xff]).await.map_err(|e| e.to_string())?;
        return Err("SOCKS5 greeting has no methods".into());
    }
    let mut methods = vec![0; greeting[1] as usize];
    s.read_exact(&mut methods)
        .await
        .map_err(|e| e.to_string())?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await.map_err(|e| e.to_string())?;
        return Err("SOCKS5 NO AUTH not offered".into());
    }
    s.write_all(&[5, 0]).await.map_err(|e| e.to_string())?;
    let mut h = [0; 4];
    s.read_exact(&mut h).await.map_err(|e| e.to_string())?;
    if h[0] != 5 || h[2] != 0 {
        socks_reply(s, 1).await?;
        return Err("invalid SOCKS5 request".into());
    }
    if h[1] != 1 {
        socks_reply(s, 7).await?;
        return Err("unsupported SOCKS5 command".into());
    }
    let host = match h[3] {
        1 => {
            let mut a = [0; 4];
            s.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        4 => {
            let mut a = [0; 16];
            s.read_exact(&mut a).await.map_err(|e| e.to_string())?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        3 => {
            let n = s.read_u8().await.map_err(|e| e.to_string())?;
            if n == 0 {
                socks_reply(s, 8).await?;
                return Err("empty SOCKS5 domain".into());
            }
            let mut d = vec![0; n as usize];
            s.read_exact(&mut d).await.map_err(|e| e.to_string())?;
            let d = match String::from_utf8(d) {
                Ok(d) if valid_token(&d, "SOCKS5 domain").is_ok() => d,
                _ => {
                    socks_reply(s, 8).await?;
                    return Err("invalid SOCKS5 domain".into());
                }
            };
            d
        }
        _ => {
            socks_reply(s, 8).await?;
            return Err("unsupported SOCKS5 address type".into());
        }
    };
    let port = s.read_u16().await.map_err(|e| e.to_string())?;
    if port == 0 {
        socks_reply(s, 1).await?;
        return Err("SOCKS5 port must be non-zero".into());
    }
    Ok(SocksTarget { host, port })
}

async fn serve_dynamic(
    mut stream: TcpStream,
    generation: Arc<Session>,
    mut cancelled: watch::Receiver<bool>,
) -> Result<(), String> {
    let handshake = tokio::time::timeout(SOCKS_HANDSHAKE_TIMEOUT, parse_socks5(&mut stream));
    let target = tokio::select! {
        biased;
        _ = cancelled.changed() => return Err("dynamic forward cancelled".into()),
        result = handshake => result.map_err(|_| "SOCKS5 handshake timed out".to_string())??,
    };
    let Session::Ssh(ssh) = generation.as_ref() else {
        socks_reply(&mut stream, 1).await?;
        return Err("SSH generation changed".into());
    };
    super::direct_tcpip::relay_socks5(ssh, stream, &target.host, target.port, cancelled).await?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_dynamic_forward_start(
    app: AppHandle,
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
    bind_host: String,
    local_port: u16,
    recreate_on_reconnect: Option<bool>,
) -> Result<DynamicForwardView, String> {
    (async {
    let bind_ip = parse_bind(&bind_host)?;
    let mut binding_retired = pty.subscribe_binding_retired(&binding)?;
    let (physical_id, generation) = ssh_generation(&pty, &binding)?;
    if matches!(generation.as_ref(), Session::Ssh(ssh) if ssh.transport_lost()) {
        return Err("SSH session binding is stale".into());
    }
    let count = || {
        state
            .rules
            .lock()
            .map(|r| {
                r.values()
                    .filter(|x| x.view.binding().logical_session_id == binding.logical_session_id)
                    .count()
            })
            .map_err(|_| "forward registry unavailable")
    };
    if count()? >= MAX_RULES_PER_SESSION {
        return Err(format!(
            "session forward limit ({MAX_RULES_PER_SESSION}) reached"
        ));
    }
    let listener = TcpListener::bind((bind_ip, local_port))
        .await
        .map_err(|e| format!("cannot bind dynamic forward: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let binding_lease = pty.acquire_commit_lease(&binding)?;
    let (after_id, after) = ssh_generation(&pty, &binding)?;
    if after_id != physical_id
        || !Arc::ptr_eq(&generation, &after)
        || *binding_retired.borrow()
        || matches!(after.as_ref(), Session::Ssh(ssh) if ssh.transport_lost())
    {
        return Err("SSH session generation changed while starting forward".into());
    }
    let rule_id = format!("df-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let view = DynamicForwardView {
        rule_id: rule_id.clone(),
        binding: binding.clone(),
        bind_host,
        local_port: port,
        requested_local_port: local_port,
        recreate_on_reconnect: recreate_on_reconnect.unwrap_or(false),
    };
    let (cancel, mut cancelled) = watch::channel(false);
    let (completion_tx, completion_rx) = watch::channel(false);
    {
        let mut rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        if rules
            .values()
            .filter(|x| x.view.binding().logical_session_id == binding.logical_session_id)
            .count()
            >= MAX_RULES_PER_SESSION
        {
            return Err(format!(
                "session forward limit ({MAX_RULES_PER_SESSION}) reached"
            ));
        }
        rules.insert(
            rule_id.clone(),
            Rule {
                view: RuleView::Dynamic(view.clone()),
                generation: generation.clone(),
                cancel: cancel.clone(),
                completed: completion_rx,
            },
        );
    }
    if pty.get_for_ssh_binding(&binding).is_none_or(|current| {
        !Arc::ptr_eq(&current, &generation)
            || !matches!(current.as_ref(), Session::Ssh(ssh) if !ssh.transport_lost())
    }) || *binding_retired.borrow()
    {
        if let Ok(mut rules) = state.rules.lock() {
            rules.remove(&rule_id);
        }
        let _ = cancel.send(true);
        return Err("SSH session generation changed while registering forward".into());
    }
    drop(binding_lease);
    let preserve_for_snapshot = view.recreate_on_reconnect;
    tokio::spawn(async move {
        let mut relays = tokio::task::JoinSet::new();
        let Session::Ssh(ssh) = generation.as_ref() else {
            let _ = cancel.send(true);
            cleanup_rule_registration(app, rule_id, generation, false);
            let _ = completion_tx.send(true);
            return;
        };
        let exit = loop {
            tokio::select! {
                biased;
                _ = cancelled.changed() => break RuleExit::Cancelled,
                _ = ssh.wait_closed() => break RuleExit::TransportClosed,
                _ = wait_for_binding_retirement(&mut binding_retired) => break RuleExit::BindingRetired,
                accepted = listener.accept(), if can_accept_connection(relays.len()) => match accepted {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        if *cancelled.borrow() { break RuleExit::Cancelled; }
                        let pty = app.state::<PtyState>();
                        let current = pty.get_for_ssh_binding(&binding);
                        if current.as_ref().is_none_or(|s| !Arc::ptr_eq(s, &generation)) {
                            break RuleExit::BindingRetired;
                        }
                        relays.spawn(serve_dynamic(stream, generation.clone(), cancelled.clone()));
                    }
                    Ok(_) => continue,
                    Err(_) => break RuleExit::ListenerClosed,
                },
                _ = relays.join_next(), if !relays.is_empty() => {},
            }
        };
        let transport_lost = ssh.transport_lost();
        drop(listener);
        let _ = cancel.send(true);
        finish_relays(&mut relays).await;
        cleanup_rule_registration(
            app,
            rule_id,
            generation,
            preserve_for_snapshot && preserve_reconnect_snapshot(exit, transport_lost),
        );
        let _ = completion_tx.send(true);
    });
    Ok(view)

    }).await.map_err(|error: String| crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error))
}

#[tauri::command]
pub fn ssh_dynamic_forward_list(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: Option<SessionBindingV1>,
) -> Result<Vec<DynamicForwardView>, String> {
    (|| {
        if let Some(binding) = binding.as_ref() {
            valid_token(&binding.logical_session_id, "binding.logicalSessionId")?;
            valid_token(&binding.transport_generation, "binding.transportGeneration")?;
        }
        let mut rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        rules.retain(|_, rule| {
            let current = pty.get_for_ssh_binding(rule.view.binding());
            let valid = current.is_some_and(|current| Arc::ptr_eq(&current, &rule.generation));
            if !valid {
                let _ = rule.cancel.send(true);
            }
            valid
        });
        let mut out: Vec<_> = rules
            .values()
            .filter(|r| {
                binding
                    .as_ref()
                    .is_none_or(|binding| r.view.binding() == binding)
            })
            .filter_map(|r| match &r.view {
                RuleView::Dynamic(v) => Some(v.clone()),
                RuleView::Local(_) | RuleView::Remote(_) => None,
            })
            .collect();
        out.sort_by(|a, b| a.rule_id.cmp(&b.rule_id));
        Ok(out)
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[tauri::command]
pub async fn ssh_dynamic_forward_stop(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
    rule_id: String,
) -> Result<(), String> {
    (async {
        let (completed, started) =
            cancel_bound_rule(&pty, &state, &binding, &rule_id, RuleKind::Dynamic)?;
        wait_for_rule_stop(completed, started).await;
        Ok(())
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[tauri::command]
pub async fn ssh_forwarding_reconnect_snapshot(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
) -> Result<Vec<ForwardReconnectIntent>, String> {
    (async {
        let (_, authoritative) = ssh_generation(&pty, &binding)?;
        let (mut intents, captured) = {
            let mut rules = state
                .rules
                .lock()
                .map_err(|_| "forward registry unavailable")?;
            // Recheck while the registry is held: a publication concurrent with
            // the snapshot must not yield intents from a stale binding.
            let current = pty
                .get_for_ssh_binding(&binding)
                .ok_or("SSH session binding is stale")?;
            if !Arc::ptr_eq(&authoritative, &current) {
                return Err("SSH session generation changed while snapshotting forwards".into());
            }
            let mut intents = Vec::new();
            let mut captured_ids = Vec::new();
            for rule in rules.values() {
                if rule.view.binding() != &binding || !Arc::ptr_eq(&rule.generation, &authoritative)
                {
                    continue;
                }
                match &rule.view {
                    RuleView::Local(v) if v.recreate_on_reconnect => {
                        intents.push(ForwardReconnectIntent::Local {
                            old_rule_id: v.rule_id.clone(),
                            old_binding: v.binding.clone(),
                            bind_host: v.bind_host.clone(),
                            requested_local_port: v.requested_local_port,
                            old_actual_local_port: v.local_port,
                            target_host: v.target_host.clone(),
                            target_port: v.target_port,
                        });
                        captured_ids.push(v.rule_id.clone());
                    }
                    RuleView::Dynamic(v) if v.recreate_on_reconnect => {
                        intents.push(ForwardReconnectIntent::Dynamic {
                            old_rule_id: v.rule_id.clone(),
                            old_binding: v.binding.clone(),
                            bind_host: v.bind_host.clone(),
                            requested_local_port: v.requested_local_port,
                            old_actual_local_port: v.local_port,
                        });
                        captured_ids.push(v.rule_id.clone());
                    }
                    RuleView::Remote(v) if v.recreate_on_reconnect => {
                        intents.push(ForwardReconnectIntent::Remote {
                            old_rule_id: v.rule_id.clone(),
                            old_binding: v.binding.clone(),
                            remote_bind_host: v.remote_bind_host.clone(),
                            requested_remote_port: v.requested_remote_port,
                            old_actual_remote_port: v.remote_port,
                            local_target_host: v.local_target_host.clone(),
                            local_target_port: v.local_target_port,
                        });
                        captured_ids.push(v.rule_id.clone());
                    }
                    _ => {}
                }
            }
            let captured = captured_ids
                .into_iter()
                .filter_map(|rule_id| rules.remove(&rule_id))
                .map(|rule| (rule.cancel, rule.completed))
                .collect::<Vec<_>>();
            (intents, captured)
        };
        // The snapshot is the handoff boundary: do not let a zero-jitter rebuild
        // race the old listener for a fixed loopback port.
        for (cancel, completed) in captured {
            stop_rule(cancel, completed).await;
        }
        intents.sort_by(|a, b| intent_rule_id(a).cmp(intent_rule_id(b)));
        Ok(intents)
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

fn intent_rule_id(intent: &ForwardReconnectIntent) -> &str {
    match intent {
        ForwardReconnectIntent::Local { old_rule_id, .. }
        | ForwardReconnectIntent::Dynamic { old_rule_id, .. }
        | ForwardReconnectIntent::Remote { old_rule_id, .. } => old_rule_id,
    }
}

#[tauri::command]
pub async fn ssh_forwarding_reconnect_rebuild(
    app: AppHandle,
    binding: SessionBindingV1,
    intents: Vec<ForwardReconnectIntent>,
) -> Result<Vec<ForwardRebuildResult>, String> {
    (async {
        let pty = app.state::<PtyState>();
        ssh_generation(&pty, &binding)?;
        if intents.len() > MAX_RULES_PER_SESSION {
            return Err(format!(
                "reconnect intent limit ({MAX_RULES_PER_SESSION}) exceeded"
            ));
        }
        for intent in &intents {
            let (rule_id, old_binding) = match intent {
                ForwardReconnectIntent::Local {
                    old_rule_id,
                    old_binding,
                    ..
                }
                | ForwardReconnectIntent::Dynamic {
                    old_rule_id,
                    old_binding,
                    ..
                }
                | ForwardReconnectIntent::Remote {
                    old_rule_id,
                    old_binding,
                    ..
                } => (old_rule_id, old_binding),
            };
            valid_token(rule_id, "oldRuleId")?;
            valid_token(
                &old_binding.logical_session_id,
                "oldBinding.logicalSessionId",
            )?;
            valid_token(
                &old_binding.transport_generation,
                "oldBinding.transportGeneration",
            )?;
        }

        let mut results = Vec::with_capacity(intents.len());
        for intent in intents {
            let (old_rule_id, old_binding, requested, old_actual) = match &intent {
                ForwardReconnectIntent::Local {
                    old_rule_id,
                    old_binding,
                    requested_local_port,
                    old_actual_local_port,
                    ..
                }
                | ForwardReconnectIntent::Dynamic {
                    old_rule_id,
                    old_binding,
                    requested_local_port,
                    old_actual_local_port,
                    ..
                } => (
                    old_rule_id.clone(),
                    old_binding,
                    *requested_local_port,
                    *old_actual_local_port,
                ),
                ForwardReconnectIntent::Remote {
                    old_rule_id,
                    old_binding,
                    requested_remote_port,
                    old_actual_remote_port,
                    ..
                } => (
                    old_rule_id.clone(),
                    old_binding,
                    *requested_remote_port,
                    *old_actual_remote_port,
                ),
            };
            if old_binding.logical_session_id != binding.logical_session_id {
                results.push(ForwardRebuildResult {
                    old_rule_id,
                    old_actual_local_port: old_actual,
                    requested_local_port: requested,
                    new_actual_local_port: None,
                    new_rule_id: None,
                    failure: Some(ForwardRebuildFailure::InvalidIntent),
                });
                continue;
            }

            // Release this exact old listener before attempting a fixed-port bind.
            let old = {
                let state = app.state::<ForwardingState>();
                let mut rules = state
                    .rules
                    .lock()
                    .map_err(|_| "forward registry unavailable")?;
                let matches = rules
                    .get(&old_rule_id)
                    .is_some_and(|r| r.view.binding() == old_binding);
                if matches {
                    rules.remove(&old_rule_id).map(|r| (r.cancel, r.completed))
                } else {
                    None
                }
            };
            if let Some((cancel, completed)) = old {
                stop_rule(cancel, completed).await;
            }

            let started = match intent {
                ForwardReconnectIntent::Local {
                    bind_host,
                    target_host,
                    target_port,
                    ..
                } => ssh_local_forward_start(
                    app.clone(),
                    app.state(),
                    app.state(),
                    binding.clone(),
                    bind_host,
                    requested,
                    target_host,
                    target_port,
                    Some(true),
                )
                .await
                .map(|v| (v.rule_id, v.local_port)),
                ForwardReconnectIntent::Dynamic { bind_host, .. } => ssh_dynamic_forward_start(
                    app.clone(),
                    app.state(),
                    app.state(),
                    binding.clone(),
                    bind_host,
                    requested,
                    Some(true),
                )
                .await
                .map(|v| (v.rule_id, v.local_port)),
                ForwardReconnectIntent::Remote {
                    remote_bind_host,
                    local_target_host,
                    local_target_port,
                    ..
                } => ssh_remote_forward_start(
                    app.clone(),
                    app.state(),
                    app.state(),
                    binding.clone(),
                    remote_bind_host,
                    requested,
                    local_target_host,
                    local_target_port,
                    Some(true),
                )
                .await
                .map(|v| (v.rule_id, v.remote_port)),
            };
            results.push(match started {
                Ok((new_rule_id, new_port)) => ForwardRebuildResult {
                    old_rule_id,
                    old_actual_local_port: old_actual,
                    requested_local_port: requested,
                    new_actual_local_port: Some(new_port),
                    new_rule_id: Some(new_rule_id),
                    failure: None,
                },
                Err(error) => ForwardRebuildResult {
                    old_rule_id,
                    old_actual_local_port: old_actual,
                    requested_local_port: requested,
                    new_actual_local_port: None,
                    new_rule_id: None,
                    failure: Some(classify_rebuild_failure(&error, requested)),
                },
            });
        }
        Ok(results)
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

fn classify_rebuild_failure(error: &str, requested_port: u16) -> ForwardRebuildFailure {
    if requested_port != 0
        && (error == "SSH_FORWARDING_FIXED_PORT_UNAVAILABLE"
            || error.contains("cannot bind")
            || error.contains("remote forward rejected")
            || error.contains("tcpip-forward"))
    {
        ForwardRebuildFailure::FixedPortUnavailable
    } else if error == "SSH_FORWARDING_STALE_BINDING"
        || error.contains("stale")
        || error.contains("generation changed")
    {
        ForwardRebuildFailure::StaleBinding
    } else if error == "SSH_FORWARDING_LIMIT_EXCEEDED" || error.contains("limit") {
        ForwardRebuildFailure::LimitExceeded
    } else if error == "SSH_FORWARDING_INVALID_INTENT"
        || error.contains("must be")
        || error.contains("invalid")
    {
        ForwardRebuildFailure::InvalidIntent
    } else {
        ForwardRebuildFailure::Internal
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_remote_forward_start(
    app: AppHandle,
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
    remote_bind_host: String,
    remote_port: u16,
    local_target_host: String,
    local_target_port: u16,
    recreate_on_reconnect: Option<bool>,
) -> Result<RemoteForwardView, String> {
    (async {
        let remote_ip = parse_bind(&remote_bind_host)?;
        let local_ip = parse_bind(&local_target_host)?;
        if local_target_port == 0 {
            return Err("localTargetPort must be non-zero".into());
        }
        let mut binding_retired = pty.subscribe_binding_retired(&binding)?;
        let (physical_id, generation) = ssh_generation(&pty, &binding)?;
        if matches!(generation.as_ref(), Session::Ssh(ssh) if ssh.transport_lost()) {
            return Err("SSH session binding is stale".into());
        }
        {
            let rules = state
                .rules
                .lock()
                .map_err(|_| "forward registry unavailable")?;
            if rules
                .values()
                .filter(|r| r.view.binding().logical_session_id == binding.logical_session_id)
                .count()
                >= MAX_RULES_PER_SESSION
            {
                return Err(format!(
                    "session forward limit ({MAX_RULES_PER_SESSION}) reached"
                ));
            }
        }

        let Session::Ssh(ssh) = generation.as_ref() else {
            return Err("binding does not identify an SSH session".into());
        };
        let allocated = ssh
            .request_tcpip_forward(&remote_ip.to_string(), u32::from(remote_port))
            .await?;
        let actual_port = if remote_port == 0 {
            u16::try_from(allocated).map_err(|_| "remote allocated port is invalid")?
        } else {
            remote_port
        };
        if actual_port == 0 {
            return Err("remote forward did not allocate a port".into());
        }
        let still_current = ssh_generation(&pty, &binding).is_ok_and(
            |(physical_after, generation_after)| {
                physical_after == physical_id
                    && Arc::ptr_eq(&generation, &generation_after)
                    && !*binding_retired.borrow()
                    && matches!(generation_after.as_ref(), Session::Ssh(ssh) if !ssh.transport_lost())
            },
        );
        if !still_current {
            let Session::Ssh(ssh) = generation.as_ref() else {
                return Err("SSH session generation changed while starting forward".into());
            };
            let _ = ssh
                .cancel_tcpip_forward(&remote_ip.to_string(), u32::from(actual_port))
                .await;
            return Err("SSH session generation changed while starting forward".into());
        }
        let binding_lease = match pty.acquire_commit_lease(&binding) {
            Ok(lease) => lease,
            Err(error) => {
                let _ = ssh
                    .cancel_tcpip_forward(&remote_ip.to_string(), u32::from(actual_port))
                    .await;
                return Err(error);
            }
        };

        let rule_id = format!("rf-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let view = RemoteForwardView {
            rule_id: rule_id.clone(),
            binding: binding.clone(),
            remote_bind_host,
            remote_port: actual_port,
            requested_remote_port: remote_port,
            recreate_on_reconnect: recreate_on_reconnect.unwrap_or(false),
            local_target_host: local_target_host.clone(),
            local_target_port,
        };
        let (cancel, cancelled) = watch::channel(false);
        let (completion_tx, completion_rx) = watch::channel(false);
        let over_session_limit = {
            let mut rules = state
                .rules
                .lock()
                .map_err(|_| "forward registry unavailable")?;
            if rules
                .values()
                .filter(|r| r.view.binding().logical_session_id == binding.logical_session_id)
                .count()
                >= MAX_RULES_PER_SESSION
            {
                true
            } else {
                rules.insert(
                    rule_id.clone(),
                    Rule {
                        view: RuleView::Remote(view.clone()),
                        generation: generation.clone(),
                        cancel: cancel.clone(),
                        completed: completion_rx,
                    },
                );
                false
            }
        };
        if over_session_limit {
            drop(binding_lease);
            let Session::Ssh(ssh) = generation.as_ref() else {
                return Err(format!(
                    "session forward limit ({MAX_RULES_PER_SESSION}) reached"
                ));
            };
            let _ = ssh
                .cancel_tcpip_forward(&remote_ip.to_string(), u32::from(actual_port))
                .await;
            return Err(format!(
                "session forward limit ({MAX_RULES_PER_SESSION}) reached"
            ));
        }
        let Session::Ssh(ssh) = generation.as_ref() else {
            return Err("binding does not identify an SSH session".into());
        };
        if let Err(error) = ssh.reverse_forward_hub().insert(
            &remote_ip.to_string(),
            u32::from(actual_port),
            local_ip,
            local_target_port,
            cancelled.clone(),
        ) {
            if let Ok(mut rules) = state.rules.lock() {
                rules.remove(&rule_id);
            }
            let _ = cancel.send(true);
            drop(binding_lease);
            let _ = ssh
                .cancel_tcpip_forward(&remote_ip.to_string(), u32::from(actual_port))
                .await;
            return Err(error);
        }
        if !ssh_generation(&pty, &binding).is_ok_and(|(_, current)| {
            Arc::ptr_eq(&current, &generation)
                && matches!(current.as_ref(), Session::Ssh(ssh) if !ssh.transport_lost())
        }) || *binding_retired.borrow()
        {
            if let Ok(mut rules) = state.rules.lock() {
                rules.remove(&rule_id);
            }
            ssh.reverse_forward_hub()
                .remove(&remote_ip.to_string(), u32::from(actual_port));
            let _ = cancel.send(true);
            drop(binding_lease);
            let _ = ssh
                .cancel_tcpip_forward(&remote_ip.to_string(), u32::from(actual_port))
                .await;
            return Err("SSH session generation changed while registering forward".into());
        }
        drop(binding_lease);

        let preserve_for_snapshot = view.recreate_on_reconnect;
        let hub = ssh.reverse_forward_hub().clone();
        let bind_host = remote_ip.to_string();
        tokio::spawn(async move {
            let mut cancelled = cancelled;
            let Session::Ssh(ssh) = generation.as_ref() else {
                let _ = cancel.send(true);
                hub.remove(&bind_host, u32::from(actual_port));
                cleanup_rule_registration(app, rule_id, generation, false);
                let _ = completion_tx.send(true);
                return;
            };
            let exit = tokio::select! {
                biased;
                _ = cancelled.changed() => RuleExit::Cancelled,
                _ = ssh.wait_closed() => RuleExit::TransportClosed,
                _ = wait_for_binding_retirement(&mut binding_retired) => RuleExit::BindingRetired,
            };
            let transport_lost = ssh.transport_lost();
            let _ = cancel.send(true);
            hub.remove(&bind_host, u32::from(actual_port));
            if let Session::Ssh(ssh) = generation.as_ref() {
                let _ = ssh
                    .cancel_tcpip_forward(&bind_host, u32::from(actual_port))
                    .await;
            }
            cleanup_rule_registration(
                app,
                rule_id,
                generation,
                preserve_for_snapshot && preserve_reconnect_snapshot(exit, transport_lost),
            );
            let _ = completion_tx.send(true);
        });
        Ok(view)
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[tauri::command]
pub fn ssh_remote_forward_list(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: Option<SessionBindingV1>,
) -> Result<Vec<RemoteForwardView>, String> {
    (|| {
        if let Some(binding) = binding.as_ref() {
            valid_token(&binding.logical_session_id, "binding.logicalSessionId")?;
            valid_token(&binding.transport_generation, "binding.transportGeneration")?;
        }
        let mut rules = state
            .rules
            .lock()
            .map_err(|_| "forward registry unavailable")?;
        rules.retain(|_, rule| {
            let current = pty.get_for_ssh_binding(rule.view.binding());
            let valid = current.is_some_and(|current| Arc::ptr_eq(&current, &rule.generation));
            if !valid {
                let _ = rule.cancel.send(true);
            }
            valid
        });
        let mut views: Vec<_> = rules
            .values()
            .filter(|r| {
                binding
                    .as_ref()
                    .is_none_or(|binding| r.view.binding() == binding)
            })
            .filter_map(|r| match &r.view {
                RuleView::Remote(view) => Some(view.clone()),
                RuleView::Local(_) | RuleView::Dynamic(_) => None,
            })
            .collect();
        views.sort_by(|a, b| a.rule_id.cmp(&b.rule_id));
        Ok(views)
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[tauri::command]
pub async fn ssh_remote_forward_stop(
    pty: State<'_, PtyState>,
    state: State<'_, ForwardingState>,
    binding: SessionBindingV1,
    rule_id: String,
) -> Result<(), String> {
    (async {
        let (completed, started) =
            cancel_bound_rule(&pty, &state, &binding, &rule_id, RuleKind::Remote)?;
        wait_for_rule_stop(completed, started).await;
        Ok(())
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Forwarding, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(generation: &str) -> SessionBindingV1 {
        SessionBindingV1 {
            logical_session_id: "session-a".into(),
            physical_pty_id: 7,
            transport_generation: generation.into(),
        }
    }

    #[test]
    fn bind_validation_is_exact() {
        assert!(parse_bind("127.0.0.1").is_ok());
        assert!(parse_bind("::1").is_ok());
        assert!(parse_bind("0.0.0.0").is_err());
        assert!(parse_bind("127.0.0.2").is_err());
        assert!(parse_bind("localhost").is_err());
    }

    #[tokio::test]
    async fn loopback_ephemeral_bindings_report_real_ports() {
        for host in ["127.0.0.1", "::1"] {
            let listener = TcpListener::bind((parse_bind(host).unwrap(), 0))
                .await
                .unwrap();
            assert_ne!(listener.local_addr().unwrap().port(), 0);
        }
    }

    #[tokio::test]
    async fn fixed_loopback_bind_conflict_does_not_fall_back() {
        let first = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let fixed = first.local_addr().unwrap().port();
        assert!(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, fixed))
            .await
            .is_err());
    }

    #[test]
    fn rebuild_failures_are_typed_and_never_echo_raw_errors() {
        assert!(matches!(
            classify_rebuild_failure("cannot bind local forward: private OS detail", 8123),
            ForwardRebuildFailure::FixedPortUnavailable
        ));
        assert!(matches!(
            classify_rebuild_failure("SSH session binding is stale", 0),
            ForwardRebuildFailure::StaleBinding
        ));
        assert!(matches!(
            classify_rebuild_failure("SSH_FORWARDING_FIXED_PORT_UNAVAILABLE", 8123),
            ForwardRebuildFailure::FixedPortUnavailable
        ));
        assert!(matches!(
            classify_rebuild_failure("SSH_FORWARDING_STALE_BINDING", 0),
            ForwardRebuildFailure::StaleBinding
        ));
        assert!(matches!(
            classify_rebuild_failure("SSH_FORWARDING_LIMIT_EXCEEDED", 0),
            ForwardRebuildFailure::LimitExceeded
        ));
        assert!(matches!(
            classify_rebuild_failure("SSH_FORWARDING_INVALID_INTENT", 0),
            ForwardRebuildFailure::InvalidIntent
        ));
    }

    #[test]
    fn reconnect_intent_preserves_requested_and_actual_ports() {
        let intent = ForwardReconnectIntent::Dynamic {
            old_rule_id: "df-1".into(),
            old_binding: binding("old"),
            bind_host: "127.0.0.1".into(),
            requested_local_port: 0,
            old_actual_local_port: 43123,
        };
        let json = serde_json::to_value(&intent).unwrap();
        assert_eq!(json["requestedLocalPort"], 0);
        assert_eq!(json["oldActualLocalPort"], 43123);
        assert_eq!(
            serde_json::from_value::<ForwardReconnectIntent>(json).unwrap(),
            intent
        );

        let remote = ForwardReconnectIntent::Remote {
            old_rule_id: "rf-1".into(),
            old_binding: binding("old"),
            remote_bind_host: "127.0.0.1".into(),
            requested_remote_port: 0,
            old_actual_remote_port: 18080,
            local_target_host: "127.0.0.1".into(),
            local_target_port: 5173,
        };
        let json = serde_json::to_value(&remote).unwrap();
        assert_eq!(json["requestedRemotePort"], 0);
        assert_eq!(json["oldActualRemotePort"], 18080);
        assert_eq!(json["localTargetPort"], 5173);
        assert_eq!(
            serde_json::from_value::<ForwardReconnectIntent>(json).unwrap(),
            remote
        );
    }

    #[test]
    fn cancellation_cleans_registry_primitive() {
        let (tx, rx) = watch::channel(false);
        assert!(!*rx.borrow());
        tx.send(true).unwrap();
        assert!(*rx.borrow());
    }

    #[tokio::test]
    async fn binding_retirement_wait_is_immediate_and_fail_closed() {
        let (retire, mut retired) = watch::channel(false);
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(10),
                wait_for_binding_retirement(&mut retired),
            )
            .await
            .is_err(),
            "a live binding must not retire spontaneously"
        );
        retire.send(true).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            wait_for_binding_retirement(&mut retired),
        )
        .await
        .expect("retirement state is retained without polling");

        let (sender, mut dropped) = watch::channel(false);
        drop(sender);
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            wait_for_binding_retirement(&mut dropped),
        )
        .await
        .expect("a lost binding authority fails closed");
    }

    #[test]
    fn reconnect_snapshot_requires_transport_loss_from_a_lifecycle_exit() {
        assert!(preserve_reconnect_snapshot(RuleExit::TransportClosed, true));
        assert!(preserve_reconnect_snapshot(RuleExit::BindingRetired, true));
        assert!(!preserve_reconnect_snapshot(RuleExit::Cancelled, true));
        assert!(!preserve_reconnect_snapshot(RuleExit::ListenerClosed, true));
        assert!(!preserve_reconnect_snapshot(
            RuleExit::TransportClosed,
            false
        ));
    }

    #[test]
    fn forwarding_lifecycle_has_no_timer_poll_fallback() {
        let forbidden = ["from_millis", "(100)"].concat();
        assert!(!include_str!("forwarding.rs").contains(&forbidden));
    }

    #[test]
    fn connection_limit_and_backend_generation_are_exact() {
        assert!(can_accept_connection(MAX_CONNECTIONS_PER_RULE - 1));
        assert!(!can_accept_connection(MAX_CONNECTIONS_PER_RULE));
        assert_eq!(binding("tg-current"), binding("tg-current"));
        assert_ne!(binding("tg-current"), binding("tg-stale"));
    }

    #[test]
    fn stale_generation_stop_after_replacement_cancels_no_rule() {
        let pty = PtyState::default();
        let state = ForwardingState::default();
        let (binding_a, generation_a) = pty.insert_test_binding("session-a", "generation-a");
        let (cancel_a, cancelled_a) = watch::channel(false);
        let (_completed_a, completion_a) = watch::channel(false);
        state.rules.lock().unwrap().insert(
            "lf-a".into(),
            Rule {
                view: RuleView::Local(LocalForwardView {
                    rule_id: "lf-a".into(),
                    binding: binding_a.clone(),
                    bind_host: "127.0.0.1".into(),
                    local_port: 2201,
                    requested_local_port: 2201,
                    recreate_on_reconnect: false,
                    target_host: "target-a".into(),
                    target_port: 22,
                }),
                generation: generation_a,
                cancel: cancel_a,
                completed: completion_a,
            },
        );

        // Publish generation B before the delayed generation-A stop arrives.
        let (binding_b, generation_b) = pty.insert_test_binding("session-a", "generation-b");
        let (cancel_b, cancelled_b) = watch::channel(false);
        let (_completed_b, completion_b) = watch::channel(false);
        state.rules.lock().unwrap().insert(
            "df-b".into(),
            Rule {
                view: RuleView::Dynamic(DynamicForwardView {
                    rule_id: "df-b".into(),
                    binding: binding_b,
                    bind_host: "127.0.0.1".into(),
                    local_port: 2202,
                    requested_local_port: 2202,
                    recreate_on_reconnect: false,
                }),
                generation: generation_b,
                cancel: cancel_b,
                completed: completion_b,
            },
        );

        assert!(cancel_bound_rule(&pty, &state, &binding_a, "lf-a", RuleKind::Local,).is_err());
        assert!(!*cancelled_a.borrow(), "stale A rule was cancelled");
        assert!(!*cancelled_b.borrow(), "replacement B rule was cancelled");
        assert_eq!(state.rules.lock().unwrap().len(), 2);
        pty.close_all();
    }

    async fn parse(input: &[u8]) -> (Result<SocksTarget, String>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(512);
        let bytes = input.to_vec();
        let writer = tokio::spawn(async move {
            client.write_all(&bytes).await.unwrap();
            client.shutdown().await.unwrap();
            let mut replies = Vec::new();
            client.read_to_end(&mut replies).await.unwrap();
            replies
        });
        let result = parse_socks5(&mut server).await;
        drop(server);
        (result, writer.await.unwrap())
    }

    #[tokio::test]
    async fn socks5_negotiation_and_targets_are_strict() {
        let (target, reply) = parse(&[
            5, 1, 0, 5, 1, 0, 3, 11, b'E', b'x', b'A', b'm', b'P', b'l', b'E', b'.', b'C', b'o',
            b'M', 1, 187,
        ])
        .await;
        assert_eq!(
            target.unwrap(),
            SocksTarget {
                host: "ExAmPlE.CoM".into(),
                port: 443
            }
        );
        assert_eq!(reply, [5, 0]);

        let (target, _) = parse(&[5, 1, 0, 5, 1, 0, 1, 192, 0, 2, 1, 0, 80]).await;
        assert_eq!(target.unwrap().host, "192.0.2.1");
        let mut ipv6 = vec![5, 1, 0, 5, 1, 0, 4];
        ipv6.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        ipv6.extend_from_slice(&22_u16.to_be_bytes());
        assert_eq!(parse(&ipv6).await.0.unwrap().host, "::1");
    }

    #[tokio::test]
    async fn socks5_rejects_methods_commands_and_malformed_requests() {
        assert_eq!(parse(&[5, 1, 2]).await.1, [5, 0xff]);
        assert!(parse(&[5, 0]).await.0.is_err());
        assert!(parse(&[4, 1, 0]).await.0.is_err());
        for command in [2, 3] {
            assert_eq!(
                parse(&[5, 1, 0, 5, command, 0, 1]).await.1,
                [5, 0, 5, 7, 0, 1, 0, 0, 0, 0, 0, 0]
            );
        }
        assert_eq!(parse(&[5, 1, 0, 5, 1, 0, 9]).await.1[3], 8);
        assert_eq!(parse(&[5, 1, 0, 5, 1, 0, 3, 0]).await.1[3], 8);
        assert_eq!(parse(&[5, 1, 0, 5, 1, 1, 1]).await.1[3], 1);
        assert!(parse(&[5]).await.0.is_err());
        assert!(parse(&[5, 1]).await.0.is_err());
        assert!(parse(&[5, 1, 0, 5, 1, 0, 1, 127]).await.0.is_err());
    }

    #[tokio::test]
    async fn socks5_accepts_fragmented_input() {
        let (mut client, mut server) = tokio::io::duplex(64);
        let parser = tokio::spawn(async move { parse_socks5(&mut server).await });
        for byte in [5, 1, 0] {
            client.write_all(&[byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
        let mut selected = [0; 2];
        client.read_exact(&mut selected).await.unwrap();
        assert_eq!(selected, [5, 0]);
        for byte in [5, 1, 0, 3, 3, b'A', b'B', b'c', 0, 80] {
            client.write_all(&[byte]).await.unwrap();
            tokio::task::yield_now().await;
        }
        assert_eq!(
            parser.await.unwrap().unwrap(),
            SocksTarget {
                host: "ABc".into(),
                port: 80
            }
        );
    }
}
