//! Versioned, serializable SSH flow contracts. These types deliberately do not
//! change the legacy string-error commands; v2 callers can use the typed seam.

use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::{hash_map::Entry, HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingV1 {
    pub logical_session_id: String,
    pub physical_pty_id: u32,
    pub transport_generation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SshStage {
    #[serde(rename = "DNS")]
    Dns,
    #[serde(rename = "TCP")]
    Tcp,
    #[serde(rename = "handshake")]
    Handshake,
    #[serde(rename = "hostKey")]
    HostKey,
    #[serde(rename = "auth")]
    Auth,
    #[serde(rename = "jump")]
    Jump,
    #[serde(rename = "target")]
    Target,
    #[serde(rename = "openShell")]
    OpenShell,
    #[serde(rename = "SFTP")]
    Sftp,
    #[serde(rename = "transfer")]
    Transfer,
    #[serde(rename = "forward")]
    Forward,
    #[serde(rename = "reconnect")]
    Reconnect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshErrorCode {
    Ok,
    InvalidRequest,
    DnsFailed,
    ConnectionRefused,
    Timeout,
    HostKeyRejected,
    AuthenticationFailed,
    TransportClosed,
    Unsupported,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HopRole {
    Direct,
    Jump,
    Target,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticV1 {
    pub schema_version: u8,
    pub stage: SshStage,
    pub code: SshErrorCode,
    pub severity: DiagnosticSeverity,
    pub retryable: bool,
    pub hop_role: HopRole,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<SessionBindingV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_context: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandErrorV1 {
    pub diagnostic: SshDiagnosticV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticRequestV1 {
    pub request_id: String,
    pub session_id: String,
    pub host: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDiagnosticEventV1 {
    pub request_id: String,
    pub status: DiagnosticStatus,
    pub diagnostic: SshDiagnosticV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticStatus {
    Passed,
    Failed,
    Skipped,
}

const MAX_PRE_CANCELLED: usize = 128;
const PRE_CANCEL_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct RunRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
    pre_cancelled: VecDeque<(String, Instant)>,
}

impl RunRegistry {
    fn prune(&mut self, now: Instant) {
        while self
            .pre_cancelled
            .front()
            .is_some_and(|(_, created)| now.duration_since(*created) >= PRE_CANCEL_TTL)
        {
            self.pre_cancelled.pop_front();
        }
    }
}

fn runs() -> &'static Mutex<RunRegistry> {
    static RUNS: OnceLock<Mutex<RunRegistry>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(RunRegistry::default()))
}

struct RunGuard {
    request_id: String,
    cancelled: Arc<AtomicBool>,
}

impl RunGuard {
    fn register(request_id: String) -> Option<Self> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut registry = runs().lock().unwrap_or_else(|error| error.into_inner());
        registry.prune(Instant::now());
        if let Some(index) = registry
            .pre_cancelled
            .iter()
            .position(|(id, _)| id == &request_id)
        {
            registry.pre_cancelled.remove(index);
            cancelled.store(true, Ordering::Release);
        }
        match registry.active.entry(request_id.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(cancelled.clone());
                Some(Self {
                    request_id,
                    cancelled,
                })
            }
            Entry::Occupied(_) => None,
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut active = runs().lock().unwrap_or_else(|error| error.into_inner());
        if active
            .active
            .get(&self.request_id)
            .is_some_and(|flag| Arc::ptr_eq(flag, &self.cancelled))
        {
            active.active.remove(&self.request_id);
        }
    }
}

fn diagnostic(
    stage: SshStage,
    code: SshErrorCode,
    severity: DiagnosticSeverity,
    retryable: bool,
) -> SshDiagnosticV1 {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    SshDiagnosticV1 {
        schema_version: 1,
        stage,
        code,
        severity,
        retryable,
        hop_role: HopRole::Direct,
        timestamp,
        binding: None,
        safe_context: None,
    }
}

fn emit(
    channel: &Channel<SshDiagnosticEventV1>,
    request_id: &str,
    status: DiagnosticStatus,
    value: SshDiagnosticV1,
) {
    let _ = channel.send(SshDiagnosticEventV1 {
        request_id: request_id.to_owned(),
        status,
        diagnostic: value,
    });
}

async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn invalid_request(stage: SshStage) -> SshCommandErrorV1 {
    SshCommandErrorV1 {
        diagnostic: diagnostic(
            stage,
            SshErrorCode::InvalidRequest,
            DiagnosticSeverity::Error,
            false,
        ),
    }
}

pub(crate) fn redacted_log_message(
    stage: SshStage,
    code: SshErrorCode,
    _raw_error: &str,
) -> String {
    let stage = serde_json::to_value(stage)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    let code = serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "internal".to_owned());
    format!("ssh operation failed stage={stage} code={code}")
}

/// Safe probe: resolves and opens TCP only. It never starts SSH, a shell, or a remote command.
#[tauri::command]
pub async fn ssh_diagnostic_run_v1(
    request: SshDiagnosticRequestV1,
    channel: Channel<SshDiagnosticEventV1>,
) -> Result<(), SshCommandErrorV1> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || request.session_id.is_empty()
        || request.host.is_empty()
        || request.host.len() > 253
        || request.host.chars().any(char::is_control)
        || request.port == Some(0)
    {
        return Err(invalid_request(SshStage::Dns));
    }

    let Some(run) = RunGuard::register(request.request_id.clone()) else {
        return Err(invalid_request(SshStage::Dns));
    };
    let port = request.port.unwrap_or(22);
    let resolved = tokio::select! {
        _ = cancelled(&run.cancelled) => return Ok(()),
        result = tokio::time::timeout(
            Duration::from_secs(8),
            tokio::net::lookup_host((request.host.as_str(), port)),
        ) => result,
    };
    let (addresses, dns_failure) = match resolved {
        Ok(Ok(values)) => {
            let addresses = values.collect::<Vec<_>>();
            let failed = addresses.is_empty();
            emit(
                &channel,
                &request.request_id,
                if failed {
                    DiagnosticStatus::Failed
                } else {
                    DiagnosticStatus::Passed
                },
                diagnostic(
                    SshStage::Dns,
                    if failed {
                        SshErrorCode::DnsFailed
                    } else {
                        SshErrorCode::Ok
                    },
                    if failed {
                        DiagnosticSeverity::Error
                    } else {
                        DiagnosticSeverity::Info
                    },
                    failed,
                ),
            );
            (addresses, failed.then_some(SshErrorCode::DnsFailed))
        }
        Ok(Err(_)) => {
            emit(
                &channel,
                &request.request_id,
                DiagnosticStatus::Failed,
                diagnostic(
                    SshStage::Dns,
                    SshErrorCode::DnsFailed,
                    DiagnosticSeverity::Error,
                    true,
                ),
            );
            (Vec::new(), Some(SshErrorCode::DnsFailed))
        }
        Err(_) => {
            emit(
                &channel,
                &request.request_id,
                DiagnosticStatus::Failed,
                diagnostic(
                    SshStage::Dns,
                    SshErrorCode::Timeout,
                    DiagnosticSeverity::Error,
                    true,
                ),
            );
            (Vec::new(), Some(SshErrorCode::Timeout))
        }
    };

    if !addresses.is_empty() && !run.is_cancelled() {
        let result = tokio::select! {
            _ = cancelled(&run.cancelled) => return Ok(()),
            result = tokio::time::timeout(
                Duration::from_secs(8),
                tokio::net::TcpStream::connect(addresses.as_slice()),
            ) => result,
        };
        let code = match result {
            Ok(Ok(_)) => SshErrorCode::Ok,
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                SshErrorCode::ConnectionRefused
            }
            Ok(Err(_)) => SshErrorCode::TransportClosed,
            Err(_) => SshErrorCode::Timeout,
        };
        let passed = code == SshErrorCode::Ok;
        emit(
            &channel,
            &request.request_id,
            if passed {
                DiagnosticStatus::Passed
            } else {
                DiagnosticStatus::Failed
            },
            diagnostic(
                SshStage::Tcp,
                code,
                if passed {
                    DiagnosticSeverity::Info
                } else {
                    DiagnosticSeverity::Error
                },
                !passed,
            ),
        );
    } else if !run.is_cancelled() {
        let Some(code) = dns_failure else {
            return Ok(());
        };
        emit(
            &channel,
            &request.request_id,
            DiagnosticStatus::Skipped,
            diagnostic(SshStage::Tcp, code, DiagnosticSeverity::Info, true),
        );
    }

    if !run.is_cancelled() {
        for stage in [
            SshStage::Handshake,
            SshStage::HostKey,
            SshStage::Auth,
            SshStage::Jump,
            SshStage::Target,
            SshStage::OpenShell,
            SshStage::Sftp,
            SshStage::Transfer,
            SshStage::Forward,
            SshStage::Reconnect,
        ] {
            emit(
                &channel,
                &request.request_id,
                DiagnosticStatus::Skipped,
                diagnostic(
                    stage,
                    SshErrorCode::Unsupported,
                    DiagnosticSeverity::Info,
                    false,
                ),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_diagnostic_cancel_v1(request_id: String) -> bool {
    if request_id.is_empty() || request_id.len() > 128 {
        return false;
    }
    let mut registry = runs().lock().unwrap_or_else(|error| error.into_inner());
    if let Some(flag) = registry.active.get(&request_id) {
        flag.store(true, Ordering::Release);
        return true;
    }
    let now = Instant::now();
    registry.prune(now);
    if !registry
        .pre_cancelled
        .iter()
        .any(|(id, _)| id == &request_id)
    {
        if registry.pre_cancelled.len() == MAX_PRE_CANCELLED {
            registry.pre_cancelled.pop_front();
        }
        registry.pre_cancelled.push_back((request_id, now));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_are_camel_case_and_stage_spelling_is_stable() {
        let binding = SessionBindingV1 {
            logical_session_id: "logical".into(),
            physical_pty_id: 7,
            transport_generation: "opaque".into(),
        };
        let json = serde_json::to_value(binding).unwrap();
        assert_eq!(json["logicalSessionId"], "logical");
        assert_eq!(json["physicalPtyId"], 7);
        assert_eq!(serde_json::to_value(SshStage::Dns).unwrap(), "DNS");
        assert_eq!(serde_json::to_value(SshStage::HostKey).unwrap(), "hostKey");
        assert_eq!(serde_json::to_value(HopRole::Direct).unwrap(), "direct");

        let diagnostic = SshDiagnosticV1 {
            schema_version: 1,
            stage: SshStage::Tcp,
            code: SshErrorCode::Timeout,
            severity: DiagnosticSeverity::Error,
            retryable: true,
            hop_role: HopRole::Direct,
            timestamp: 123,
            binding: None,
            safe_context: None,
        };
        let json = serde_json::to_value(diagnostic).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["retryable"], true);
        assert_eq!(json["hopRole"], "direct");
        assert!(json.get("safeContext").is_none());
    }

    #[test]
    fn active_run_ids_are_unique_and_cancelled_without_replacement_races() {
        let id = "diagnostic-registry-test".to_string();
        let first = RunGuard::register(id.clone()).unwrap();
        assert!(RunGuard::register(id.clone()).is_none());
        assert!(ssh_diagnostic_cancel_v1(id.clone()));
        assert!(first.is_cancelled());
        drop(first);
        assert!(ssh_diagnostic_cancel_v1(id.clone()));
        let pre_cancelled = RunGuard::register(id.clone()).unwrap();
        assert!(pre_cancelled.is_cancelled());
        drop(pre_cancelled);
        assert!(RunGuard::register(id).is_some());
    }

    #[test]
    fn serialized_diagnostic_never_contains_a_raw_error_canary() {
        let canary = "CANARY-password-passphrase-known-host-comment";
        let value = diagnostic(
            SshStage::Auth,
            SshErrorCode::AuthenticationFailed,
            DiagnosticSeverity::Error,
            false,
        );
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(!serialized.contains(canary));
        assert_eq!(value.safe_context, None);
        let log = redacted_log_message(SshStage::Auth, SshErrorCode::Internal, canary);
        assert!(!log.contains(canary));
        assert_eq!(log, "ssh operation failed stage=auth code=internal");
    }
}
