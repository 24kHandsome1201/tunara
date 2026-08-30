//! Unified lifecycle, progress, and cancellation seam for SSH transfers.
//!
//! `resolve_session` validates A0's stable `SessionBindingV1` before returning
//! an SFTP channel, keeping session ownership out of queue and recovery code.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

use super::super::connection::await_stage;
use super::super::diagnostics::SessionBindingV1;
use super::super::transfer_journal::{
    self, PartialIdentity, RecoveryObservation, RecoveryPreparation, SourceIdentity,
    TransferJournalRecord,
};
use super::super::{sftp, sftp_common};
use crate::modules::pty::{PtyState, Session};

const CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const EVENT_INTERVAL: Duration = Duration::from_millis(100);
const REGISTRY_TOMBSTONE_TTL: Duration = Duration::from_secs(30);
const MAX_REGISTRY_TOMBSTONES: usize = 256;

#[derive(Clone, Debug, Hash, Eq, PartialEq)]
struct TransferKey {
    transfer_id: String,
    attempt: u32,
}

#[derive(Clone, Copy, PartialEq)]
enum AttemptStatus {
    Active,
    Committing,
}

#[derive(Default)]
struct Registry {
    active: HashMap<TransferKey, (AttemptStatus, Arc<AtomicBool>)>,
    pending_cancels: VecDeque<(Instant, TransferKey)>,
    completed: VecDeque<(Instant, TransferKey)>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

#[derive(Default)]
struct PermitState {
    global: usize,
    connections: HashMap<u32, usize>,
}

struct PermitCoordinator {
    state: Mutex<PermitState>,
    changed: Notify,
}

static PERMITS: OnceLock<PermitCoordinator> = OnceLock::new();

fn permits() -> &'static PermitCoordinator {
    PERMITS.get_or_init(|| PermitCoordinator {
        state: Mutex::new(PermitState::default()),
        changed: Notify::new(),
    })
}

struct TransferPermit(u32);

impl Drop for TransferPermit {
    fn drop(&mut self) {
        let coordinator = permits();
        let mut state = coordinator.state.lock().unwrap_or_else(|p| p.into_inner());
        state.global -= 1;
        if let Some(count) = state.connections.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                state.connections.remove(&self.0);
            }
        }
        drop(state);
        coordinator.changed.notify_waiters();
    }
}

async fn acquire_permit(connection: u32, cancelled: &AtomicBool) -> Result<TransferPermit, ()> {
    let coordinator = permits();
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(());
        }
        // Register for notification before inspecting counters. Both counters
        // are reserved in one critical section, so a waiter never hoards one
        // permit while waiting for the other.
        let notified = coordinator.changed.notified();
        {
            let mut state = coordinator.state.lock().unwrap_or_else(|p| p.into_inner());
            let per_connection = state.connections.get(&connection).copied().unwrap_or(0);
            if state.global < 4 && per_connection < 2 {
                state.global += 1;
                *state.connections.entry(connection).or_default() += 1;
                return Ok(TransferPermit(connection));
            }
        }
        tokio::select! {
            _ = notified => {},
            _ = tokio::time::sleep(Duration::from_millis(25)) => {},
        }
    }
}

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

fn prune_tombstones(registry: &mut Registry) {
    let now = Instant::now();
    for tombstones in [&mut registry.pending_cancels, &mut registry.completed] {
        while tombstones
            .front()
            .is_some_and(|(created, _)| now.duration_since(*created) > REGISTRY_TOMBSTONE_TTL)
        {
            tombstones.pop_front();
        }
        while tombstones.len() > MAX_REGISTRY_TOMBSTONES {
            tombstones.pop_front();
        }
    }
}

struct Registration {
    key: TransferKey,
    cancelled: Arc<AtomicBool>,
}

impl Registration {
    fn register(key: TransferKey) -> Result<Self, String> {
        if key.transfer_id.is_empty()
            || key.transfer_id.len() > 128
            || key.attempt == 0
            || !key.transfer_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err("invalid transfer attempt identity".into());
        }

        let mut registry = registry()
            .lock()
            .map_err(|_| "transfer registry unavailable".to_string())?;
        prune_tombstones(&mut registry);
        if registry.active.contains_key(&key)
            || registry
                .completed
                .iter()
                .any(|(_, completed)| completed == &key)
        {
            return Err("transfer attempt identity already used".into());
        }

        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(index) = registry
            .pending_cancels
            .iter()
            .position(|(_, pending)| pending == &key)
        {
            registry.pending_cancels.remove(index);
            cancelled.store(true, Ordering::Release);
        }
        registry
            .active
            .insert(key.clone(), (AttemptStatus::Active, Arc::clone(&cancelled)));
        Ok(Self { key, cancelled })
    }

    /// Atomically closes the cancellation window before a publish mutation.
    fn begin_commit(&self) -> bool {
        let mut registry = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        let Some((status, _)) = registry.active.get_mut(&self.key) else {
            return false;
        };
        *status = AttemptStatus::Committing;
        true
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let mut registry = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.active.remove(&self.key);
        registry
            .completed
            .push_back((Instant::now(), self.key.clone()));
        prune_tombstones(&mut registry);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    transfer_id: String,
    attempt: u32,
    sequence: u64,
    phase: TransferPhase,
    bytes_transferred: u64,
    total_bytes: Option<u64>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum TransferPhase {
    Preparing,
    Transferring,
    Committing,
    Terminal,
}

struct EventEmitter {
    channel: Channel<TransferEvent>,
    key: TransferKey,
    sequence: u64,
    last_progress: Option<Instant>,
}

impl EventEmitter {
    fn emit(
        &mut self,
        phase: TransferPhase,
        bytes_transferred: u64,
        total_bytes: Option<u64>,
        force: bool,
    ) {
        let now = Instant::now();
        if !force
            && self
                .last_progress
                .is_some_and(|last| now.duration_since(last) < EVENT_INTERVAL)
        {
            return;
        }
        self.sequence = self.sequence.saturating_add(1);
        self.last_progress = Some(now);
        let _ = self.channel.send(TransferEvent {
            transfer_id: self.key.transfer_id.clone(),
            attempt: self.key.attempt,
            sequence: self.sequence,
            phase,
            bytes_transferred,
            total_bytes,
        });
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TransferOutcome {
    Completed {
        bytes_transferred: u64,
    },
    Cancelled {
        bytes_transferred: u64,
        residue_path: Option<String>,
    },
    Failed {
        bytes_transferred: u64,
        code: TransferFailureCode,
        message: &'static str,
        residue_path: Option<String>,
    },
    OutcomeUnknown {
        bytes_transferred: u64,
        code: TransferFailureCode,
        message: &'static str,
        residue_path: Option<String>,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferFailureCode {
    TransferFailed,
    OutcomeUnknown,
}

#[derive(Serialize)]
pub struct TransferResponse {
    outcome: TransferOutcome,
}

const TRANSFER_FAILED_MESSAGE: &str =
    "The transfer failed safely. Review the recovery state before retrying.";
const TRANSFER_OUTCOME_UNKNOWN_MESSAGE: &str =
    "The transfer outcome is unknown. Reconcile recovery state before retrying.";

fn failed_outcome<M: AsRef<str>>(
    bytes_transferred: u64,
    _private_message: M,
    residue_path: Option<String>,
) -> TransferOutcome {
    TransferOutcome::Failed {
        bytes_transferred,
        code: TransferFailureCode::TransferFailed,
        message: TRANSFER_FAILED_MESSAGE,
        residue_path,
    }
}

fn unknown_outcome<M: AsRef<str>>(
    bytes_transferred: u64,
    _private_message: M,
    residue_path: Option<String>,
) -> TransferOutcome {
    TransferOutcome::OutcomeUnknown {
        bytes_transferred,
        code: TransferFailureCode::OutcomeUnknown,
        message: TRANSFER_OUTCOME_UNKNOWN_MESSAGE,
        residue_path,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelResult {
    Accepted,
    TooLate,
    NotFound,
}

fn transfer_key(transfer_id: String, attempt: u32) -> TransferKey {
    TransferKey {
        transfer_id,
        attempt,
    }
}

#[tauri::command]
pub fn ssh_transfer_cancel(transfer_id: String, attempt: u32) -> CancelResult {
    let key = transfer_key(transfer_id.clone(), attempt);
    let mut registry = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_tombstones(&mut registry);

    if let Some((status, cancelled)) = registry.active.get(&key) {
        if *status == AttemptStatus::Committing {
            return CancelResult::TooLate;
        }
        cancelled.store(true, Ordering::Release);
        permits().changed.notify_waiters();
        // The compatibility upload loop also has a legacy cancellation flag.
        let _ = sftp::cancel_upload(key.transfer_id);
        return CancelResult::Accepted;
    }
    if registry
        .completed
        .iter()
        .any(|(_, completed)| completed == &key)
    {
        return CancelResult::NotFound;
    }
    if !registry
        .pending_cancels
        .iter()
        .any(|(_, pending)| pending == &key)
    {
        registry.pending_cancels.push_back((Instant::now(), key));
        prune_tombstones(&mut registry);
    }
    CancelResult::Accepted
}

/// The only binding resolver used by transfer operations. A0's authoritative
/// registry validates logical id, physical id, and backend generation together.
async fn resolve_session(
    state: &tauri::State<'_, PtyState>,
    binding: &SessionBindingV1,
) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
    sftp_common::session_for_binding(state, binding).await
}

fn random_partial_sibling(target: &Path) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "destination has no parent directory".to_string())?;
    let name = target
        .file_name()
        .ok_or_else(|| "destination must name a file".to_string())?
        .to_string_lossy();
    for _ in 0..16 {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|error| format!("randomness unavailable: {error}"))?;
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let candidate = parent.join(format!(".{name}.tunara-{token}.partial"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("could not allocate a local download partial after 16 attempts".into())
}

/// A same-directory hard link is an atomic no-replace publish primitive on the
/// local filesystems supported by Tauri. The partial is never renamed over an
/// existing destination.
async fn publish_no_replace(partial: &Path, target: &Path) -> Result<(), (String, bool)> {
    tokio::fs::hard_link(partial, target)
        .await
        .map_err(|error| {
            (
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "destination already exists".to_string()
                } else {
                    format!("secure no-replace publish failed: {error}")
                },
                false,
            )
        })?;
    tokio::fs::remove_file(partial).await.map_err(|error| {
        (
            format!("download published but partial cleanup failed: {error}"),
            true,
        )
    })
}

fn local_identity(path: &Path, size: u64) -> Result<PartialIdentity, String> {
    let md = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if md.file_type().is_symlink() || !md.is_file() || md.len() != size {
        return Err("local partial identity changed".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(PartialIdentity::Local {
            path: path.display().to_string(),
            size,
            dev: Some(md.dev()),
            ino: Some(md.ino()),
        })
    }
    #[cfg(not(unix))]
    {
        Ok(PartialIdentity::Local {
            path: path.display().to_string(),
            size,
            dev: None,
            ino: None,
        })
    }
}

fn local_snapshot(path: &Path) -> Result<(u64, String, PartialIdentity), String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        hash.update(&buffer[..count]);
    }
    Ok((
        bytes,
        format!("{:x}", hash.finalize()),
        local_identity(path, bytes)?,
    ))
}

fn validated_resume_record(
    preparation: RecoveryPreparation,
    direction: &str,
    source: &str,
    final_path: &str,
) -> Result<TransferJournalRecord, String> {
    let record = preparation.record;
    if preparation.observation != RecoveryObservation::PartialMatches
        || !record.paused
        || record.commit_intent
        || record.bytes == 0
        || record.direction != direction
        || record.source != source
        || record.final_path != final_path
    {
        return Err("recovery record does not match the requested transfer".into());
    }
    let expected_shape = match direction {
        "download" => {
            matches!(&record.source_identity, SourceIdentity::Remote { .. })
                && matches!(&record.partial, PartialIdentity::Local { .. })
                && !record.overwrite.unwrap_or(false)
        }
        "upload" => {
            matches!(&record.source_identity, SourceIdentity::Local { .. })
                && matches!(&record.partial, PartialIdentity::Remote { .. })
        }
        _ => false,
    };
    if !expected_shape {
        return Err("recovery record direction or path ownership is invalid".into());
    }
    Ok(record)
}

fn upload_overwrite(record: Option<&TransferJournalRecord>, requested: bool) -> bool {
    record.map_or(requested, |record| {
        record.overwrite.unwrap_or_else(|| {
            matches!(&record.partial, PartialIdentity::Remote { path, .. } if path != &record.final_path)
        })
    })
}

fn validate_download_completion(bytes_transferred: u64, expected: u64) -> Result<(), String> {
    if bytes_transferred == expected {
        Ok(())
    } else {
        Err(format!(
            "remote download ended early: received {bytes_transferred} of {expected} bytes"
        ))
    }
}

struct OpenedUploadSource {
    file: std::fs::File,
    length: u64,
    initial_hash: String,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl OpenedUploadSource {
    fn open(path: &Path) -> Result<Self, String> {
        let path_metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("inspect upload source failed: {error}"))?;
        if !path_metadata.file_type().is_file() {
            return Err("upload source must be a regular file (symlinks are not followed)".into());
        }
        let mut file = std::fs::File::open(path)
            .map_err(|error| format!("open upload source failed: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("inspect opened upload source failed: {error}"))?;
        if !metadata.is_file() {
            return Err("opened upload source is not a regular file".into());
        }
        let (snapshot_bytes, initial_hash) = Self::hash_from_start(&mut file)?;
        if snapshot_bytes != metadata.len() {
            return Err("upload source changed while its initial snapshot was read".into());
        }
        let snapshot_metadata = file
            .metadata()
            .map_err(|error| format!("revalidate upload source snapshot failed: {error}"))?;
        if !snapshot_metadata.is_file() || snapshot_metadata.len() != metadata.len() {
            return Err("upload source changed while its initial snapshot was read".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if path_metadata.dev() != metadata.dev()
                || path_metadata.ino() != metadata.ino()
                || snapshot_metadata.dev() != metadata.dev()
                || snapshot_metadata.ino() != metadata.ino()
            {
                return Err("upload source changed while it was being opened".into());
            }
            Ok(Self {
                file,
                length: metadata.len(),
                initial_hash,
                dev: metadata.dev(),
                ino: metadata.ino(),
            })
        }
        #[cfg(not(unix))]
        Ok(Self {
            file,
            length: metadata.len(),
            initial_hash,
        })
    }

    fn hash_from_start(file: &mut std::fs::File) -> Result<(u64, String), String> {
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("rewind opened upload source failed: {error}"))?;
        let mut hash = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|error| format!("snapshot opened upload source failed: {error}"))?;
            if count == 0 {
                break;
            }
            bytes = bytes.saturating_add(count as u64);
            hash.update(&buffer[..count]);
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("rewind opened upload source failed: {error}"))?;
        Ok((bytes, format!("{:x}", hash.finalize())))
    }

    /// Validate through the retained descriptor, rather than reopening a path
    /// which may now name a different file.
    fn validate_before_commit(
        &mut self,
        transferred: u64,
        streamed_hash: &str,
    ) -> Result<(), String> {
        if transferred != self.length {
            return Err(format!(
                "upload source changed during transfer: transferred {transferred} of {} initial bytes",
                self.length
            ));
        }
        let metadata = self
            .file
            .metadata()
            .map_err(|error| format!("revalidate opened upload source failed: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.dev() != self.dev || metadata.ino() != self.ino {
                return Err("upload source identity changed during transfer".into());
            }
        }
        if !metadata.is_file() || metadata.len() != self.length {
            return Err("upload source length or type changed during transfer".into());
        }
        let (final_bytes, final_hash) = Self::hash_from_start(&mut self.file)?;
        if final_bytes != self.length
            || streamed_hash != self.initial_hash
            || final_hash != self.initial_hash
        {
            return Err("upload source contents changed during transfer".into());
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_transfer_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    transfer_id: String,
    attempt: u32,
    remote_path: String,
    local_path: String,
    recovery_id: Option<String>,
    create_parents: Option<bool>,
    on_event: Channel<TransferEvent>,
) -> Result<TransferResponse, String> {
    (async {
        let key = transfer_key(transfer_id.clone(), attempt);
        let registration = Registration::register(key.clone())?;
        let mut emitter = EventEmitter {
            channel: on_event,
            key: key.clone(),
            sequence: 0,
            last_progress: None,
        };
        emitter.emit(TransferPhase::Preparing, 0, None, true);

        let _permit = match acquire_permit(binding.physical_pty_id, &registration.cancelled).await {
            Ok(permit) => permit,
            Err(()) => {
                emitter.emit(TransferPhase::Terminal, 0, None, true);
                return Ok(TransferResponse {
                    outcome: TransferOutcome::Cancelled {
                        bytes_transferred: 0,
                        residue_path: None,
                    },
                });
            }
        };

        if create_parents == Some(true) {
            sftp::ensure_download_parents(&local_path)?;
        }
        let target = sftp::validate_download_target(&local_path)?;
        let resume_record = match recovery_id.as_deref() {
            Some(recovery_id) => Some(validated_resume_record(
                transfer_journal::ssh_transfer_recovery_prepare(
                    app.clone(),
                    state.clone(),
                    binding.clone(),
                    recovery_id.into(),
                )
                .await?,
                "download",
                &remote_path,
                &target.display().to_string(),
            )?),
            None => None,
        };
        let resume_offset = resume_record.as_ref().map_or(0, |record| record.bytes);
        let partial = match resume_record.as_ref().map(|record| &record.partial) {
            Some(PartialIdentity::Local { path, .. }) => PathBuf::from(path),
            Some(PartialIdentity::Remote { .. }) => {
                return Err("download recovery partial must be local".into())
            }
            None => random_partial_sibling(&target)?,
        };
        let sftp = resolve_session(&state, &binding).await?;
        let remote_metadata = await_stage(
            "stat remote download",
            CONTROL_TIMEOUT,
            sftp.symlink_metadata(&remote_path),
        )
        .await?;
        if remote_metadata.is_symlink() || !remote_metadata.is_regular() {
            return Err("download source must be a non-symlink regular file".into());
        }
        let total = remote_metadata
            .size
            .ok_or("remote download size is unknown")?;
        let session = state
            .get_for_ssh_binding(&binding)
            .ok_or("stale or invalid SSH session binding")?;
        let (endpoint, user, host_key) = match session.as_ref() {
            Session::Ssh(ssh) => ssh.transfer_identity(),
            Session::Local(_) => return Err("not a remote session".into()),
        };
        let mut remote = await_stage(
            "open remote download",
            CONTROL_TIMEOUT,
            sftp.open(&remote_path),
        )
        .await?;
        if resume_offset > 0 {
            use tokio::io::AsyncSeekExt;
            remote
                .seek(std::io::SeekFrom::Start(resume_offset))
                .await
                .map_err(|error| format!("seek remote download failed: {error}"))?;
        }
        let mut local = if resume_offset > 0 {
            tokio::fs::OpenOptions::new()
                .write(true)
                .append(true)
                .open(&partial)
                .await
                .map_err(|error| format!("open local download partial failed: {error}"))?
        } else {
            tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)
                .await
                .map_err(|error| format!("create local download partial failed: {error}"))?
        };

        let initial_identity = local_identity(&partial, resume_offset)?;
        if resume_record
            .as_ref()
            .is_some_and(|record| record.partial != initial_identity)
        {
            return Err("download recovery partial identity changed before claim".into());
        }
        let mut hasher = Sha256::new();
        if resume_offset > 0 {
            let mut existing = std::fs::File::open(&partial)
                .map_err(|error| format!("read download partial for resume failed: {error}"))?;
            let mut buffer = vec![0_u8; 64 * 1024];
            let mut hashed = 0_u64;
            loop {
                let count = existing
                    .read(&mut buffer)
                    .map_err(|error| format!("hash download partial for resume failed: {error}"))?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
                hashed += count as u64;
            }
            if hashed != resume_offset {
                return Err("download partial size does not match resume offset".into());
            }
            if resume_record.as_ref().is_some_and(|record| {
                format!("{:x}", hasher.clone().finalize()) != record.prefix_sha256
            }) {
                return Err("download recovery partial hash changed before claim".into());
            }
        }
        let recovery_id = if let Some(record) = &resume_record {
            transfer_journal::reactivate(
                &app,
                &record.recovery_id,
                record,
                &transfer_id,
                attempt,
                &binding.logical_session_id,
            )?
            .recovery_id
        } else {
            match transfer_journal::create(
                &app,
                TransferJournalRecord {
                    recovery_id: String::new(),
                    transfer_id: transfer_id.clone(),
                    attempt,
                    direction: "download".into(),
                    session: Some(binding.logical_session_id.clone()),
                    endpoint,
                    user,
                    host_key,
                    source: remote_path.clone(),
                    source_identity: SourceIdentity::Remote {
                        path: remote_path.clone(),
                        size: total,
                        permissions: remote_metadata.permissions,
                    },
                    final_path: target.display().to_string(),
                    overwrite: Some(false),
                    partial: initial_identity,
                    phase: "transferring".into(),
                    bytes: 0,
                    prefix_sha256: format!("{:x}", Sha256::digest([])),
                    final_sha256: None,
                    commit_intent: false,
                    paused: false,
                    needs_reconcile: false,
                },
            ) {
                Ok(recovery_id) => recovery_id,
                Err(error) => {
                    emitter.emit(TransferPhase::Terminal, 0, Some(total), true);
                    return Ok(TransferResponse {
                        outcome: failed_outcome(
                            0,
                            format!("download journal allocation failed: {error}"),
                            Some(partial.display().to_string()),
                        ),
                    });
                }
            }
        };

        let mut bytes_transferred = resume_offset;
        let mut last_checkpoint = Instant::now();
        let mut buffer = vec![0_u8; 64 * 1024];
        emitter.emit(
            TransferPhase::Transferring,
            resume_offset,
            Some(total),
            true,
        );
        let transfer_result: Result<(), String> = async {
            loop {
                if registration.cancelled.load(Ordering::Acquire) {
                    return Err("transfer cancelled".into());
                }
                let count = await_stage(
                    "read remote download chunk",
                    CHUNK_TIMEOUT,
                    remote.read(&mut buffer),
                )
                .await?;
                if count == 0 {
                    break;
                }
                if bytes_transferred.saturating_add(count as u64) > sftp::MAX_DOWNLOAD_BYTES {
                    return Err(format!(
                        "remote file exceeds download limit ({} MiB)",
                        sftp::MAX_DOWNLOAD_BYTES / (1024 * 1024)
                    ));
                }
                local
                    .write_all(&buffer[..count])
                    .await
                    .map_err(|error| format!("write local download partial failed: {error}"))?;
                bytes_transferred += count as u64;
                hasher.update(&buffer[..count]);
                if last_checkpoint.elapsed() >= EVENT_INTERVAL {
                    transfer_journal::checkpoint(
                        &app,
                        &recovery_id,
                        bytes_transferred,
                        format!("{:x}", hasher.clone().finalize()),
                        local_identity(&partial, bytes_transferred)?,
                    )?;
                    last_checkpoint = Instant::now();
                }
                emitter.emit(
                    TransferPhase::Transferring,
                    bytes_transferred,
                    Some(total),
                    false,
                );
            }
            local
                .sync_all()
                .await
                .map_err(|error| format!("sync local download partial failed: {error}"))?;
            validate_download_completion(bytes_transferred, total)?;
            let after = await_stage(
                "revalidate remote download source",
                CONTROL_TIMEOUT,
                sftp.symlink_metadata(&remote_path),
            )
            .await?;
            if after.is_symlink()
                || !after.is_regular()
                || after.size != remote_metadata.size
                || after.permissions != remote_metadata.permissions
            {
                return Err("remote download source changed during transfer".into());
            }
            // Metadata cannot detect an in-place, same-size source mutation.
            // Re-read the same open handle before publishing every download so
            // neither a fresh nor resumed transfer can commit torn content.
            use tokio::io::AsyncSeekExt;
            remote
                .seek(std::io::SeekFrom::Start(0))
                .await
                .map_err(|error| format!("rewind remote download for readback failed: {error}"))?;
            let mut readback_hash = Sha256::new();
            let mut readback_bytes = 0_u64;
            loop {
                let count = await_stage(
                    "read remote download verification",
                    CHUNK_TIMEOUT,
                    remote.read(&mut buffer),
                )
                .await?;
                if count == 0 {
                    break;
                }
                readback_bytes = readback_bytes.saturating_add(count as u64);
                if readback_bytes > bytes_transferred {
                    return Err("remote download verification exceeded expected size".into());
                }
                readback_hash.update(&buffer[..count]);
            }
            if readback_bytes != bytes_transferred
                || readback_hash.finalize()[..] != hasher.clone().finalize()[..]
            {
                return Err("remote download verification SHA-256 mismatch".into());
            }
            Ok(())
        }
        .await;

        drop(local);
        let outcome = if let Err(message) = transfer_result {
            let persistence =
                local_snapshot(&partial).and_then(|(actual_bytes, hash, identity)| {
                    bytes_transferred = actual_bytes;
                    transfer_journal::checkpoint(&app, &recovery_id, actual_bytes, hash, identity)
                        .and_then(|_| transfer_journal::pause(&app, &recovery_id, false))
                });
            let residue_path = Some(partial.display().to_string());
            if let Err(error) = persistence {
                unknown_outcome(
                    bytes_transferred,
                    format!("{message}; recovery state could not be persisted: {error}"),
                    residue_path,
                )
            } else if registration.cancelled.load(Ordering::Acquire) {
                TransferOutcome::Cancelled {
                    bytes_transferred,
                    residue_path,
                }
            } else {
                failed_outcome(bytes_transferred, message, residue_path)
            }
        } else if registration.cancelled.load(Ordering::Acquire) {
            let residue_path = Some(partial.display().to_string());
            let persistence = local_identity(&partial, bytes_transferred).and_then(|identity| {
                transfer_journal::checkpoint(
                    &app,
                    &recovery_id,
                    bytes_transferred,
                    format!("{:x}", hasher.clone().finalize()),
                    identity,
                )
                .and_then(|_| transfer_journal::pause(&app, &recovery_id, false))
            });
            match persistence {
                Ok(()) => TransferOutcome::Cancelled {
                    bytes_transferred,
                    residue_path,
                },
                Err(message) => {
                    let _ = transfer_journal::pause(&app, &recovery_id, true);
                    unknown_outcome(
                        bytes_transferred,
                        format!("download cancellation recovery state is unknown: {message}"),
                        residue_path,
                    )
                }
            }
        } else {
            let final_hash = format!("{:x}", hasher.finalize());
            let persistence = local_identity(&partial, bytes_transferred).and_then(|identity| {
                transfer_journal::checkpoint(
                    &app,
                    &recovery_id,
                    bytes_transferred,
                    final_hash.clone(),
                    identity,
                )
                .and_then(|_| {
                    transfer_journal::commit_intent(&app, &recovery_id, final_hash.clone())
                })
            });
            if let Err(message) = persistence {
                let _ = transfer_journal::pause(&app, &recovery_id, true);
                unknown_outcome(
                    bytes_transferred,
                    format!("download commit intent could not be persisted: {message}"),
                    Some(partial.display().to_string()),
                )
            } else if !registration.begin_commit() {
                match transfer_journal::pause(&app, &recovery_id, false) {
                    Ok(()) => TransferOutcome::Cancelled {
                        bytes_transferred,
                        residue_path: Some(partial.display().to_string()),
                    },
                    Err(message) => unknown_outcome(
                        bytes_transferred,
                        format!("cancelled download recovery state is unknown: {message}"),
                        Some(partial.display().to_string()),
                    ),
                }
            } else {
                emitter.emit(
                    TransferPhase::Committing,
                    bytes_transferred,
                    Some(total),
                    true,
                );
                match state.acquire_commit_lease(&binding) {
                    Err(message) => match transfer_journal::pause(&app, &recovery_id, false) {
                        Ok(()) => failed_outcome(
                            bytes_transferred,
                            message,
                            Some(partial.display().to_string()),
                        ),
                        Err(pause_error) => unknown_outcome(
                            bytes_transferred,
                            format!("{message}; recovery state could not be persisted: {pause_error}"),
                            Some(partial.display().to_string()),
                        ),
                    },
                    Ok(_commit_lease) => match publish_no_replace(&partial, &target).await {
                        Ok(()) => {
                            // The hard link publishes the exact partial inode,
                            // but another local process can write that inode.
                            // Verify the final path before reporting Completed.
                            match local_snapshot(&target) {
                                Ok((published_bytes, published_hash, _))
                                    if published_bytes == bytes_transferred
                                        && published_hash == final_hash =>
                                {
                                    match transfer_journal::remove(&app, &recovery_id) {
                                        Ok(()) => {
                                            TransferOutcome::Completed { bytes_transferred }
                                        }
                                        Err(message) => {
                                            let _ = transfer_journal::pause(
                                                &app,
                                                &recovery_id,
                                                true,
                                            );
                                            unknown_outcome(
                                                bytes_transferred,
                                                format!(
                                                    "download published but journal removal failed: {message}"
                                                ),
                                                None,
                                            )
                                        }
                                    }
                                }
                                Ok(_) => {
                                    let _ =
                                        transfer_journal::pause(&app, &recovery_id, true);
                                    unknown_outcome(
                                        bytes_transferred,
                                        "published download failed final SHA-256 verification",
                                        Some(target.display().to_string()),
                                    )
                                }
                                Err(message) => {
                                    let _ =
                                        transfer_journal::pause(&app, &recovery_id, true);
                                    unknown_outcome(
                                        bytes_transferred,
                                        format!(
                                            "published download could not be verified: {message}"
                                        ),
                                        Some(target.display().to_string()),
                                    )
                                }
                            }
                        },
                        Err((message, mutated)) if mutated => {
                            let pause_error =
                                transfer_journal::pause(&app, &recovery_id, true).err();
                            unknown_outcome(
                                bytes_transferred,
                                pause_error.map_or(message.clone(), |error| {
                                    format!(
                                        "{message}; recovery state could not be persisted: {error}"
                                    )
                                }),
                                partial.exists().then(|| partial.display().to_string()),
                            )
                        }
                        Err((message, _)) => {
                            match transfer_journal::pause(&app, &recovery_id, false) {
                                Ok(()) => failed_outcome(
                                    bytes_transferred,
                                    message,
                                    Some(partial.display().to_string()),
                                ),
                                Err(pause_error) => unknown_outcome(
                                    bytes_transferred,
                                    format!(
                                        "{message}; recovery state could not be persisted: {pause_error}"
                                    ),
                                    Some(partial.display().to_string()),
                                ),
                            }
                        }
                    },
                }
            }
        };
        emitter.emit(
            TransferPhase::Terminal,
            bytes_transferred,
            Some(total),
            true,
        );
        Ok(TransferResponse { outcome })
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Transfer, error)
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUploadError {
    kind: String,
    residue_path: Option<String>,
}

fn parse_upload_error(error: String, bytes_transferred: u64) -> TransferOutcome {
    let parsed = error
        .strip_prefix("tunaraUploadError:")
        .and_then(|json| serde_json::from_str::<LegacyUploadError>(json).ok());
    let Some(parsed) = parsed else {
        return failed_outcome(bytes_transferred, error, None);
    };
    match parsed.kind.as_str() {
        "uncertain" => unknown_outcome(bytes_transferred, error, parsed.residue_path),
        "cancelled" => TransferOutcome::Cancelled {
            bytes_transferred,
            residue_path: parsed.residue_path,
        },
        _ => failed_outcome(bytes_transferred, error, parsed.residue_path),
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_transfer_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    transfer_id: String,
    attempt: u32,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    recovery_id: Option<String>,
    on_event: Channel<TransferEvent>,
) -> Result<TransferResponse, String> {
    (async {
        let key = transfer_key(transfer_id.clone(), attempt);
        let registration = Registration::register(key.clone())?;
        let emitter = Mutex::new(EventEmitter {
            channel: on_event,
            key: key.clone(),
            sequence: 0,
            last_progress: None,
        });
        emitter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .emit(TransferPhase::Preparing, 0, None, true);

        let _permit = match acquire_permit(binding.physical_pty_id, &registration.cancelled).await {
            Ok(permit) => permit,
            Err(()) => {
                emitter.lock().unwrap_or_else(|p| p.into_inner()).emit(
                    TransferPhase::Terminal,
                    0,
                    None,
                    true,
                );
                return Ok(TransferResponse {
                    outcome: TransferOutcome::Cancelled {
                        bytes_transferred: 0,
                        residue_path: None,
                    },
                });
            }
        };

        let bytes_transferred = AtomicU64::new(0);
        let total = AtomicU64::new(u64::MAX);
        let session = state
            .get_for_ssh_binding(&binding)
            .ok_or("stale or invalid SSH session binding")?;
        let (endpoint, user, host_key) = match session.as_ref() {
            Session::Ssh(ssh) => ssh.transfer_identity(),
            Session::Local(_) => return Err("not a remote session".into()),
        };
        let resume_record = match recovery_id.as_deref() {
            Some(recovery_id) => Some(validated_resume_record(
                transfer_journal::ssh_transfer_recovery_prepare(
                    app.clone(),
                    state.clone(),
                    binding.clone(),
                    recovery_id.into(),
                )
                .await?,
                "upload",
                &local_path,
                &remote_path,
            )?),
            None => None,
        };
        let overwrite = upload_overwrite(resume_record.as_ref(), overwrite);
        let mut opened_source = OpenedUploadSource::open(Path::new(&local_path))?;
        let resume = match resume_record.as_ref().map(|record| &record.partial) {
            Some(PartialIdentity::Remote { path, .. }) => {
                Some((path.clone(), resume_record.as_ref().unwrap().bytes))
            }
            Some(PartialIdentity::Local { .. }) => {
                return Err("upload recovery partial must be remote".into())
            }
            None => None,
        };
        #[cfg(unix)]
        let source_identity = SourceIdentity::Local {
            path: local_path.clone(),
            size: opened_source.length,
            dev: opened_source.dev,
            ino: opened_source.ino,
        };
        #[cfg(not(unix))]
        let source_identity = SourceIdentity::Unverified;
        let _authoritative_sftp = resolve_session(&state, &binding).await?;
        struct UploadJournal {
            id: Option<String>,
            partial: Option<String>,
            bytes: u64,
            hash: String,
            last: Instant,
        }
        let journal = Mutex::new(UploadJournal {
            id: None,
            partial: None,
            bytes: 0,
            hash: format!("{:x}", Sha256::digest([])),
            last: Instant::now(),
        });
        let resume_snapshot = resume_record.clone();
        let result = sftp::upload_file(
            state.clone(),
            binding.physical_pty_id,
            transfer_id,
            local_path.clone(),
            Some(
                opened_source
                    .file
                    .try_clone()
                    .map_err(|error| format!("duplicate opened upload source failed: {error}"))?,
            ),
            remote_path.clone(),
            overwrite,
            |progress| {
                bytes_transferred.store(progress.transferred, Ordering::Release);
                total.store(progress.total, Ordering::Release);
                emitter
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .emit(
                        TransferPhase::Transferring,
                        progress.transferred,
                        Some(progress.total),
                        progress.transferred == 0,
                    );
            },
            Some(Arc::clone(&registration.cancelled)),
            |partial, _| {
                let (id, bytes, hash) = if let Some(record) = &resume_snapshot {
                    if !matches!(&record.partial, PartialIdentity::Remote { path, endpoint: record_endpoint, .. }
                        if path == partial && record_endpoint == &endpoint)
                    {
                        return Err("upload recovery partial changed before claim".into());
                    }
                    let claimed = transfer_journal::reactivate(
                        &app,
                        &record.recovery_id,
                        record,
                        &key.transfer_id,
                        attempt,
                        &binding.logical_session_id,
                    )?;
                    (claimed.recovery_id, claimed.bytes, claimed.prefix_sha256)
                } else {
                    let id = transfer_journal::create(
                        &app,
                        TransferJournalRecord {
                            recovery_id: String::new(),
                            transfer_id: key.transfer_id.clone(),
                            attempt,
                            direction: "upload".into(),
                            session: Some(binding.logical_session_id.clone()),
                            endpoint: endpoint.clone(),
                            user: user.clone(),
                            host_key: host_key.clone(),
                            source: local_path.clone(),
                            source_identity: source_identity.clone(),
                            final_path: remote_path.clone(),
                            overwrite: Some(overwrite),
                            partial: PartialIdentity::Remote {
                                path: partial.into(),
                                endpoint: endpoint.clone(),
                                size: 0,
                                permissions: None,
                            },
                            phase: "transferring".into(),
                            bytes: 0,
                            prefix_sha256: format!("{:x}", Sha256::digest([])),
                            final_sha256: None,
                            commit_intent: false,
                            paused: false,
                            needs_reconcile: false,
                        },
                    )?;
                    (id, 0, format!("{:x}", Sha256::digest([])))
                };
                let mut j = journal.lock().unwrap_or_else(|p| p.into_inner());
                j.id = Some(id);
                j.partial = Some(partial.into());
                j.bytes = bytes;
                j.hash = hash;
                Ok(())
            },
            |partial, bytes, hash| {
                let mut j = journal.lock().unwrap_or_else(|p| p.into_inner());
                j.bytes = bytes;
                j.hash = hash.clone();
                if j.last.elapsed() >= EVENT_INTERVAL {
                    let id = j.id.as_deref().ok_or("upload journal was not allocated")?;
                    transfer_journal::checkpoint(
                        &app,
                        id,
                        bytes,
                        hash,
                        PartialIdentity::Remote {
                            path: partial.into(),
                            endpoint: endpoint.clone(),
                            size: bytes,
                            permissions: None,
                        },
                    )?;
                    j.last = Instant::now();
                }
                Ok(())
            },
            |final_hash| {
                opened_source.validate_before_commit(
                    bytes_transferred.load(Ordering::Acquire),
                    &final_hash,
                )?;
                let id = journal.lock().unwrap_or_else(|p| p.into_inner()).id.clone();
                let partial = journal
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .partial
                    .clone();
                if id
                    .as_deref()
                    .zip(partial.as_deref())
                    .is_none_or(|(id, path)| {
                        transfer_journal::checkpoint(
                            &app,
                            id,
                            bytes_transferred.load(Ordering::Acquire),
                            final_hash.clone(),
                            PartialIdentity::Remote {
                                path: path.into(),
                                endpoint: endpoint.clone(),
                                size: bytes_transferred.load(Ordering::Acquire),
                                permissions: None,
                            },
                        )
                        .and_then(|_| transfer_journal::commit_intent(&app, id, final_hash))
                        .is_err()
                    })
                {
                    return Err("could not durably record upload commit intent".into());
                }
                if registration.begin_commit() {
                    let total = total.load(Ordering::Acquire);
                    emitter
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .emit(
                            TransferPhase::Committing,
                            bytes_transferred.load(Ordering::Acquire),
                            (total != u64::MAX).then_some(total),
                            true,
                        );
                    state.acquire_commit_lease(&binding).map(Some)
                } else {
                    Err("upload cancelled".into())
                }
            },
            resume,
        )
        .await;

        let mut outcome = match result {
            Ok(bytes_transferred) => TransferOutcome::Completed { bytes_transferred },
            Err(error) => parse_upload_error(error, bytes_transferred.load(Ordering::Acquire)),
        };
        let journal_snapshot = {
            let journal = journal.lock().unwrap_or_else(|p| p.into_inner());
            journal
                .id
                .clone()
                .zip(journal.partial.clone())
                .map(|(id, partial)| (id, partial, journal.bytes, journal.hash.clone()))
        };
        if let Some((id, partial, bytes, hash)) = journal_snapshot {
            let persistence = match &outcome {
                TransferOutcome::Completed { .. } => transfer_journal::remove(&app, &id),
                other => transfer_journal::checkpoint(
                    &app,
                    &id,
                    bytes,
                    hash,
                    PartialIdentity::Remote {
                        path: partial.clone(),
                        endpoint: endpoint.clone(),
                        size: bytes,
                        permissions: None,
                    },
                )
                .and_then(|_| {
                    transfer_journal::pause(
                        &app,
                        &id,
                        matches!(other, TransferOutcome::OutcomeUnknown { .. }),
                    )
                }),
            };
            if let Err(message) = persistence {
                let _ = transfer_journal::pause(&app, &id, true);
                outcome = unknown_outcome(
                    bytes_transferred.load(Ordering::Acquire),
                    format!("remote outcome could not be safely persisted: {message}"),
                    Some(partial),
                );
            }
        }
        let total = total.load(Ordering::Acquire);
        emitter
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .emit(
                TransferPhase::Terminal,
                bytes_transferred.load(Ordering::Acquire),
                (total != u64::MAX).then_some(total),
                true,
            );
        Ok(TransferResponse { outcome })
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Transfer, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recovery_preparation(direction: &str) -> RecoveryPreparation {
        let (source_identity, partial) = if direction == "download" {
            (
                SourceIdentity::Remote {
                    path: "/remote/source".into(),
                    size: 7,
                    permissions: Some(0o640),
                },
                PartialIdentity::Local {
                    path: "/home/user/.target.tunara-id.partial".into(),
                    size: 3,
                    dev: Some(1),
                    ino: Some(2),
                },
            )
        } else {
            (
                SourceIdentity::Local {
                    path: "/home/user/source".into(),
                    size: 7,
                    dev: 1,
                    ino: 2,
                },
                PartialIdentity::Remote {
                    path: "/remote/.target.tunara-id.partial".into(),
                    endpoint: "example:22".into(),
                    size: 3,
                    permissions: Some(0o600),
                },
            )
        };
        RecoveryPreparation {
            record: TransferJournalRecord {
                recovery_id: "recovery".into(),
                transfer_id: "old-transfer".into(),
                attempt: 1,
                direction: direction.into(),
                session: Some("session".into()),
                endpoint: "example:22".into(),
                user: "user".into(),
                host_key: "key".into(),
                source: if direction == "download" {
                    "/remote/source".into()
                } else {
                    "/home/user/source".into()
                },
                source_identity,
                final_path: if direction == "download" {
                    "/home/user/target".into()
                } else {
                    "/remote/target".into()
                },
                overwrite: Some(direction == "upload"),
                partial,
                phase: "paused".into(),
                bytes: 3,
                prefix_sha256: "a".repeat(64),
                final_sha256: None,
                commit_intent: false,
                paused: true,
                needs_reconcile: true,
            },
            observation: RecoveryObservation::PartialMatches,
        }
    }

    #[test]
    fn resume_uses_only_a_matching_verified_journal_record() {
        let download = validated_resume_record(
            recovery_preparation("download"),
            "download",
            "/remote/source",
            "/home/user/target",
        )
        .unwrap();
        assert_eq!(download.bytes, 3);
        assert!(matches!(download.partial, PartialIdentity::Local { .. }));

        assert!(validated_resume_record(
            recovery_preparation("download"),
            "download",
            "/remote/other",
            "/home/user/target",
        )
        .is_err());
        assert!(validated_resume_record(
            recovery_preparation("upload"),
            "download",
            "/home/user/source",
            "/remote/target",
        )
        .is_err());

        let mut committing = recovery_preparation("upload");
        committing.record.commit_intent = true;
        assert!(validated_resume_record(
            committing,
            "upload",
            "/home/user/source",
            "/remote/target",
        )
        .is_err());

        let mut no_replace = recovery_preparation("upload").record;
        no_replace.overwrite = Some(false);
        assert!(!upload_overwrite(Some(&no_replace), true));
        no_replace.overwrite = None;
        assert!(upload_overwrite(Some(&no_replace), false));
    }

    fn unique_key(name: &str) -> TransferKey {
        transfer_key(format!("{name}-{}", std::process::id()), 1)
    }

    #[test]
    fn cancel_before_register_is_not_lost() {
        let key = unique_key("cancel-before-register");
        assert!(matches!(
            ssh_transfer_cancel(key.transfer_id.clone(), key.attempt),
            CancelResult::Accepted
        ));
        let registration = Registration::register(key).unwrap();
        assert!(registration.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn commit_closes_the_cancellation_window() {
        let key = unique_key("cancel-vs-commit");
        let registration = Registration::register(key.clone()).unwrap();
        assert!(registration.begin_commit());
        assert!(matches!(
            ssh_transfer_cancel(key.transfer_id, key.attempt),
            CancelResult::TooLate
        ));
    }

    #[test]
    fn terminal_attempt_is_not_reused() {
        let key = unique_key("terminal-attempt");
        drop(Registration::register(key.clone()).unwrap());
        assert!(Registration::register(key.clone()).is_err());
        assert!(matches!(
            ssh_transfer_cancel(key.transfer_id, key.attempt),
            CancelResult::NotFound
        ));
    }

    #[test]
    fn lost_commit_ack_requires_reconciliation() {
        let outcome = parse_upload_error(
            r#"tunaraUploadError:{"kind":"uncertain","message":"rename acknowledgement lost","residuePath":"/.tunara-partial"}"#.into(),
            7,
        );
        assert!(matches!(outcome, TransferOutcome::OutcomeUnknown { .. }));
    }

    #[test]
    fn ok_transfer_response_serialization_redacts_every_private_message_canary() {
        const PRIVATE: &str = "/home/alice/.ssh/id_ed25519 /run/user/1000/agent.sock \
passphrase=correct-horse-battery-staple SSH_FX_PERMISSION_DENIED server=/srv/private";
        let legacy = format!(
            "tunaraUploadError:{}",
            serde_json::json!({
                "kind": "uncertain",
                "message": PRIVATE,
                "residuePath": "/safe-recovery-partial"
            })
        );
        let command_results: [Result<TransferResponse, String>; 3] = [
            Ok(TransferResponse {
                outcome: failed_outcome(3, PRIVATE, Some("/safe-recovery-partial".into())),
            }),
            Ok(TransferResponse {
                outcome: unknown_outcome(4, format!("await_stage: {PRIVATE}"), None),
            }),
            Ok(TransferResponse {
                outcome: parse_upload_error(legacy, 5),
            }),
        ];
        for result in command_results {
            let wire = serde_json::to_string(&result).expect("serialize production response");
            assert!(!wire.contains(PRIVATE));
            for canary in [
                "id_ed25519",
                "agent.sock",
                "correct-horse-battery-staple",
                "SSH_FX_PERMISSION_DENIED",
                "/srv/private",
            ] {
                assert!(!wire.contains(canary), "transfer IPC leaked {canary}");
            }
            assert!(wire.contains("code"));
            assert!(wire.contains("message"));
        }
    }

    #[test]
    fn early_download_eof_cannot_reach_commit() {
        assert!(validate_download_completion(7, 8)
            .unwrap_err()
            .contains("ended early"));
        assert!(validate_download_completion(8, 8).is_ok());
    }

    fn mutation_during_reads_does_not_commit(grow: bool) {
        use std::io::{Read, Write};

        let path = std::env::temp_dir().join(format!(
            "tunara-upload-mutation-{}-{}",
            std::process::id(),
            if grow { "grow" } else { "truncate" }
        ));
        std::fs::write(&path, vec![7_u8; 128 * 1024]).unwrap();
        let mut opened = OpenedUploadSource::open(&path).unwrap();
        let mut reader = opened.file.try_clone().unwrap();
        let mut transferred = 0_u64;
        let mut streamed_hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let count = reader.read(&mut buffer).unwrap();
        transferred += count as u64;
        streamed_hash.update(&buffer[..count]);

        if grow {
            let mut writer = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            writer.write_all(&vec![9_u8; 64 * 1024]).unwrap();
        } else {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(32 * 1024)
                .unwrap();
        }
        while let Ok(count) = reader.read(&mut buffer) {
            if count == 0 {
                break;
            }
            transferred += count as u64;
            streamed_hash.update(&buffer[..count]);
        }

        // Models the journaled partial allocated before streaming. A failed
        // gate leaves recovery state intact and never enters publication.
        let mut partial_recovery_state = Some(("partial", transferred));
        let mut commit_entered = false;
        let result = opened
            .validate_before_commit(transferred, &format!("{:x}", streamed_hash.finalize()))
            .map(|_| {
                commit_entered = true;
                partial_recovery_state = None;
            });
        assert!(result.is_err());
        assert!(!commit_entered);
        assert!(partial_recovery_state.is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn truncated_upload_source_during_reads_preserves_partial_and_skips_commit() {
        mutation_during_reads_does_not_commit(false);
    }

    #[test]
    fn grown_upload_source_during_reads_preserves_partial_and_skips_commit() {
        mutation_during_reads_does_not_commit(true);
    }

    #[test]
    fn same_length_upload_source_mutation_skips_commit() {
        use std::io::{Read, Seek, SeekFrom, Write};

        let path = std::env::temp_dir().join(format!(
            "tunara-upload-same-length-mutation-{}",
            std::process::id()
        ));
        std::fs::write(&path, vec![1_u8; 128 * 1024]).unwrap();
        let mut opened = OpenedUploadSource::open(&path).unwrap();
        let mut reader = opened.file.try_clone().unwrap();
        let mut streamed_hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let first = reader.read(&mut buffer).unwrap();
        streamed_hash.update(&buffer[..first]);

        let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        writer.seek(SeekFrom::Start(0)).unwrap();
        writer.write_all(&vec![2_u8; 64 * 1024]).unwrap();
        let second = reader.read(&mut buffer).unwrap();
        streamed_hash.update(&buffer[..second]);

        let streamed_hash = format!("{:x}", streamed_hash.finalize());
        let mut commit_entered = false;
        let result = opened
            .validate_before_commit((first + second) as u64, &streamed_hash)
            .map(|_| commit_entered = true);
        assert!(result.is_err());
        assert!(!commit_entered);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn permits_enforce_global_and_connection_limits_without_partial_holds() {
        let never = AtomicBool::new(false);
        let a1 = acquire_permit(101, &never).await.unwrap();
        let a2 = acquire_permit(101, &never).await.unwrap();
        let b1 = acquire_permit(102, &never).await.unwrap();
        let b2 = acquire_permit(102, &never).await.unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let waiter_cancelled = Arc::clone(&cancelled);
        let waiter = tokio::spawn(async move { acquire_permit(103, &waiter_cancelled).await });
        cancelled.store(true, Ordering::Release);
        permits().changed.notify_waiters();
        assert!(waiter.await.unwrap().is_err());
        drop((a1, a2, b1, b2));

        let a1 = acquire_permit(104, &never).await.unwrap();
        let a2 = acquire_permit(104, &never).await.unwrap();
        // Connection 104 is full, but it has not consumed the two remaining
        // global slots while waiting: another connection can take both.
        let b1 = acquire_permit(105, &never).await.unwrap();
        let b2 = acquire_permit(105, &never).await.unwrap();
        drop((a1, a2, b1, b2));
    }
}
