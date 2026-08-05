use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tokio::io::AsyncReadExt;

use super::diagnostics::SessionBindingV1;
use super::sftp_common;
use crate::modules::pty::{PtyState, Session};

const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 1024;
const FILE_NAME: &str = "transfer-journal.json";
static JOURNAL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SourceIdentity {
    Local {
        path: String,
        size: u64,
        dev: u64,
        ino: u64,
    },
    Remote {
        path: String,
        size: u64,
        permissions: Option<u32>,
    },
    #[default]
    Unverified,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PartialIdentity {
    Local {
        path: String,
        size: u64,
        dev: Option<u64>,
        ino: Option<u64>,
    },
    Remote {
        path: String,
        endpoint: String,
        #[serde(default)]
        size: u64,
        #[serde(default)]
        permissions: Option<u32>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJournalRecord {
    pub recovery_id: String,
    pub transfer_id: String,
    pub attempt: u32,
    pub direction: String,
    pub session: Option<String>,
    pub endpoint: String,
    pub user: String,
    pub host_key: String,
    pub source: String,
    #[serde(default)]
    pub source_identity: SourceIdentity,
    pub final_path: String,
    pub partial: PartialIdentity,
    pub phase: String,
    pub bytes: u64,
    #[serde(default)]
    pub prefix_sha256: String,
    #[serde(default)]
    pub final_sha256: Option<String>,
    pub commit_intent: bool,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub needs_reconcile: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryObservation {
    PartialMatches,
    FinalMatches,
    FinalAndPartialMatch,
}

fn recovery_observation(
    partial_matches: bool,
    final_matches: bool,
    direct_final: bool,
) -> Result<RecoveryObservation, String> {
    match (partial_matches && !direct_final, final_matches) {
        (true, true) => Ok(RecoveryObservation::FinalAndPartialMatch),
        (true, false) => Ok(RecoveryObservation::PartialMatches),
        (false, true) => Ok(RecoveryObservation::FinalMatches),
        (false, false) => Err("no recovery path matches the persisted identity".into()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPreparation {
    pub record: TransferJournalRecord,
    pub observation: RecoveryObservation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReconciliation {
    pub record: TransferJournalRecord,
    pub observation: RecoveryObservation,
    pub completed: bool,
}

#[derive(Deserialize)]
struct Envelope {
    version: u8,
    records: Vec<TransferJournalRecord>,
}
#[derive(Serialize)]
struct Current<'a> {
    version: u8,
    records: &'a [TransferJournalRecord],
}

fn canonical_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn normalize(
    mut records: Vec<TransferJournalRecord>,
) -> Result<Vec<TransferJournalRecord>, String> {
    if records.len() > MAX_RECORDS {
        return Err("transfer journal exceeds 1024 records".into());
    }
    for record in &mut records {
        let migrated = record.source_identity == SourceIdentity::Unverified
            || !canonical_hash(&record.prefix_sha256)
            || record
                .final_sha256
                .as_ref()
                .is_some_and(|h| !canonical_hash(h));
        if migrated {
            record.prefix_sha256.clear();
            record.final_sha256 = None;
            record.commit_intent = false;
            record.paused = true;
            record.needs_reconcile = true;
            record.phase = "paused".into();
        }
        if record.commit_intent && record.final_sha256.is_none() {
            return Err("commit intent requires a final full SHA-256".into());
        }
    }
    Ok(records)
}

fn load_unlocked(path: &Path) -> Result<Vec<TransferJournalRecord>, String> {
    let md = match fs::symlink_metadata(path) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("inspect transfer journal failed: {e}")),
    };
    if md.file_type().is_symlink() || !md.is_file() || md.len() > MAX_BYTES {
        return Err("transfer journal must be a regular non-symlink file under 4 MiB".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("read transfer journal failed: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid transfer journal: {e}"))?;
    let (version, records) = if value.is_array() {
        (0, serde_json::from_value(value).map_err(|e| e.to_string())?)
    } else {
        let envelope: Envelope = serde_json::from_value(value).map_err(|e| e.to_string())?;
        (envelope.version, envelope.records)
    };
    if version > 1 {
        return Err("unsupported transfer journal version".into());
    }
    normalize(records)
}

fn save_unlocked(path: &Path, records: &[TransferJournalRecord]) -> Result<(), String> {
    normalize(records.to_vec())?;
    let bytes = serde_json::to_vec(&Current {
        version: 1,
        records,
    })
    .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("transfer journal exceeds 4 MiB".into());
    }
    let parent = path.parent().ok_or("journal has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut random = [0; 16];
    getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{FILE_NAME}.{}.tmp", hex(&random)));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| format!("save transfer journal failed: {e}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join(FILE_NAME))
        .map_err(|e| e.to_string())
}
fn transaction<T>(
    app: &tauri::AppHandle,
    edit: impl FnOnce(&mut Vec<TransferJournalRecord>) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = JOURNAL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "transfer journal lock poisoned".to_string())?;
    let path = path(app)?;
    let mut records = load_unlocked(&path)?;
    let result = edit(&mut records)?;
    save_unlocked(&path, &records)?;
    Ok(result)
}

fn interrupt_records(records: &mut [TransferJournalRecord]) {
    for record in records {
        if !record.paused {
            record.paused = true;
            record.needs_reconcile = true;
            record.phase = "paused".into();
        }
    }
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    transaction(app, |records| {
        interrupt_records(records);
        Ok(())
    })
}

pub(crate) fn create(
    app: &tauri::AppHandle,
    mut record: TransferJournalRecord,
) -> Result<String, String> {
    transaction(app, |records| {
        for _ in 0..16 {
            let mut random = [0; 16];
            getrandom::fill(&mut random).map_err(|e| e.to_string())?;
            record.recovery_id = hex(&random);
            if !records
                .iter()
                .any(|existing| existing.recovery_id == record.recovery_id)
            {
                let id = record.recovery_id.clone();
                records.push(record);
                return Ok(id);
            }
        }
        Err("could not allocate a unique recovery id".into())
    })
}
pub(crate) fn checkpoint(
    app: &tauri::AppHandle,
    id: &str,
    bytes: u64,
    hash: String,
    partial: PartialIdentity,
) -> Result<(), String> {
    if !canonical_hash(&hash) {
        return Err("checkpoint requires full SHA-256".into());
    }
    transaction(app, |rs| {
        let r = find(rs, id)?;
        r.bytes = bytes;
        r.prefix_sha256 = hash;
        r.partial = partial;
        Ok(())
    })
}
pub(crate) fn commit_intent(app: &tauri::AppHandle, id: &str, hash: String) -> Result<(), String> {
    if !canonical_hash(&hash) {
        return Err("commit intent requires full SHA-256".into());
    }
    transaction(app, |rs| {
        let r = find(rs, id)?;
        r.final_sha256 = Some(hash);
        r.commit_intent = true;
        r.phase = "committing".into();
        Ok(())
    })
}
pub(crate) fn pause(app: &tauri::AppHandle, id: &str, reconcile: bool) -> Result<(), String> {
    transaction(app, |rs| {
        let r = find(rs, id)?;
        r.paused = true;
        r.needs_reconcile |= reconcile;
        r.phase = "paused".into();
        Ok(())
    })
}
pub(crate) fn remove(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    transaction(app, |rs| {
        let i = rs
            .iter()
            .position(|r| r.recovery_id == id)
            .ok_or("unknown recovery id")?;
        rs.remove(i);
        Ok(())
    })
}
fn find<'a>(
    rs: &'a mut [TransferJournalRecord],
    id: &str,
) -> Result<&'a mut TransferJournalRecord, String> {
    rs.iter_mut()
        .find(|r| r.recovery_id == id)
        .ok_or_else(|| "unknown recovery id".into())
}

fn full_hash(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut b = [0; 65536];
    loop {
        let n = f.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn local_prefix_matches(path: &Path, bytes: u64, expected_hash: &str) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut remaining = bytes;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining != 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let count = file
            .read(&mut buffer[..limit])
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(false);
        }
        remaining -= count as u64;
        hash.update(&buffer[..count]);
    }
    Ok(hex(&hash.finalize()) == expected_hash)
}

fn is_tunara_partial_name(name: &str) -> bool {
    name.starts_with('.') && name.contains(".tunara-") && name.ends_with(".partial")
}

fn verify_local(record: &TransferJournalRecord) -> Result<(), String> {
    let PartialIdentity::Local {
        path,
        size,
        dev,
        ino,
    } = &record.partial
    else {
        return Err("not a local partial".into());
    };
    let p = Path::new(path);
    let name = p
        .file_name()
        .and_then(|x| x.to_str())
        .ok_or("invalid partial filename")?;
    if !is_tunara_partial_name(name) {
        return Err("refusing cleanup of a non-Tunara partial".into());
    }
    let md = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
    if md.file_type().is_symlink() || !md.is_file() || md.len() != *size || *size != record.bytes {
        return Err("partial identity mismatch".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if dev.is_none_or(|x| x != md.dev()) || ino.is_none_or(|x| x != md.ino()) {
            return Err("partial identity mismatch".into());
        }
    }
    if !canonical_hash(&record.prefix_sha256) || full_hash(p)? != record.prefix_sha256 {
        return Err("partial content hash mismatch".into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn securely_delete_local_partial(_record: &TransferJournalRecord) -> Result<(), String> {
    Err("Unsupported: secure partial cleanup requires Unix dirfd operations".into())
}

#[cfg(unix)]
fn securely_delete_local_partial(record: &TransferJournalRecord) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let PartialIdentity::Local {
        path,
        size,
        dev,
        ino,
    } = &record.partial
    else {
        return Err("not a local partial".into());
    };
    let path = Path::new(path);
    let parent = path.parent().ok_or("partial has no parent")?;
    let basename = path.file_name().ok_or("invalid partial filename")?;
    let basename_text = basename.to_str().ok_or("invalid partial filename")?;
    if basename.as_bytes().contains(&b'/')
        || basename.as_bytes().is_empty()
        || !is_tunara_partial_name(basename_text)
    {
        return Err("refusing cleanup of a non-Tunara partial".into());
    }
    let name = CString::new(basename.as_bytes()).map_err(|_| "invalid partial filename")?;
    let dir = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent)
        .map_err(|e| e.to_string())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(format!(
            "open partial failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let opened = file.metadata().map_err(|e| e.to_string())?;
    if !opened.is_file()
        || opened.len() != *size
        || *size != record.bytes
        || dev.is_none_or(|v| v != opened.dev())
        || ino.is_none_or(|v| v != opened.ino())
    {
        return Err("partial identity mismatch".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if !canonical_hash(&record.prefix_sha256) || hex(&hash.finalize()) != record.prefix_sha256 {
        return Err("partial content hash mismatch".into());
    }
    // Re-observe the basename relative to the same anchored parent immediately
    // before unlink. This catches replacement after open/hash without resolving
    // the parent or target path again.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(format!(
            "reinspect partial failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if stat.st_dev as u64 != opened.dev()
        || stat.st_ino as u64 != opened.ino()
        || stat.st_size as u64 != opened.len()
        || (stat.st_mode & libc::S_IFMT) != libc::S_IFREG
    {
        return Err("partial identity changed before cleanup".into());
    }
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(format!(
            "delete partial failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn local_final_matches(record: &TransferJournalRecord) -> Result<bool, String> {
    let Some(expected_hash) = record.final_sha256.as_deref() else {
        return Ok(false);
    };
    let path = Path::new(&record.final_path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != record.bytes {
        return Err("published download identity mismatch".into());
    }
    Ok(full_hash(path)? == expected_hash)
}

async fn remote_file_matches(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    expected_size: u64,
    expected_hash: &str,
) -> Result<bool, String> {
    let metadata = match sftp.symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
            return Ok(false)
        }
        Err(error) => return Err(error.to_string()),
    };
    if metadata.is_symlink() || !metadata.is_regular() || metadata.size != Some(expected_size) {
        return Err("remote recovery path identity mismatch".into());
    }
    let mut file = sftp.open(path).await.map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        bytes = bytes.saturating_add(count as u64);
        if bytes > expected_size {
            return Err("remote recovery path exceeded expected size".into());
        }
        hash.update(&buffer[..count]);
    }
    Ok(bytes == expected_size && hex(&hash.finalize()) == expected_hash)
}

async fn remote_prefix_matches(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    bytes: u64,
    expected_hash: &str,
) -> Result<bool, String> {
    let mut file = sftp.open(path).await.map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut remaining = bytes;
    let mut buffer = vec![0_u8; 64 * 1024];
    while remaining != 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let count = file
            .read(&mut buffer[..limit])
            .await
            .map_err(|error| error.to_string())?;
        if count == 0 {
            return Ok(false);
        }
        remaining -= count as u64;
        hash.update(&buffer[..count]);
    }
    Ok(hex(&hash.finalize()) == expected_hash)
}

#[tauri::command]
pub fn ssh_transfer_journal_load(
    app: tauri::AppHandle,
) -> Result<Vec<TransferJournalRecord>, String> {
    (|| {
        let _g = JOURNAL_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| "journal lock")?;
        load_unlocked(&path(&app)?)
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Journal, error)
    })
}
#[tauri::command]
pub fn ssh_transfer_journal_save(
    _app: tauri::AppHandle,
    _records: Vec<TransferJournalRecord>,
) -> Result<(), String> {
    Err("complete journal replacement is not an authoritative API".into()).map_err(
        |error: String| {
            crate::modules::ssh::safe_ipc_error(
                crate::modules::ssh::SshIpcErrorKind::Journal,
                error,
            )
        },
    )
}
#[tauri::command]
pub fn ssh_transfer_journal_list_owned_partials(
    app: tauri::AppHandle,
) -> Result<Vec<TransferJournalRecord>, String> {
    (|| {
        Ok(ssh_transfer_journal_load(app)?
            .into_iter()
            .filter(|r| r.paused)
            .collect())
    })()
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Journal, error)
    })
}
#[tauri::command]
pub fn ssh_transfer_journal_cleanup(
    app: tauri::AppHandle,
    recovery_id: String,
    identity: PartialIdentity,
) -> Result<bool, String> {
    transaction(&app, |rs| {
        let i = rs
            .iter()
            .position(|r| r.recovery_id == recovery_id)
            .ok_or("unknown recovery id")?;
        if rs[i].partial != identity {
            return Err("recovery identity mismatch".into());
        }
        if !rs[i].paused {
            return Err("active transfer journal record cannot be cleaned up".into());
        }
        let PartialIdentity::Local { .. } = &rs[i].partial else {
            rs[i].needs_reconcile = true;
            rs[i].phase = "paused".into();
            return Ok(false);
        };
        securely_delete_local_partial(&rs[i])?;
        rs.remove(i);
        Ok(true)
    })
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Journal, error)
    })
}

/// Validate a paused record against the currently authoritative SSH binding.
/// This is inspection only: it never resumes, publishes, or removes anything.
#[tauri::command]
pub async fn ssh_transfer_recovery_prepare(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    recovery_id: String,
) -> Result<RecoveryPreparation, String> {
    (async {
        let record = ssh_transfer_journal_load(app)?
            .into_iter()
            .find(|r| r.recovery_id == recovery_id && r.paused)
            .ok_or("paused recovery record not found")?;
        let session = state
            .get_for_ssh_binding(&binding)
            .ok_or("stale or invalid SSH session binding")?;
        let identity = match session.as_ref() {
            Session::Ssh(ssh) => ssh.transfer_identity(),
            Session::Local(_) => return Err("not a remote session".into()),
        };
        if identity
            != (
                record.endpoint.clone(),
                record.user.clone(),
                record.host_key.clone(),
            )
        {
            return Err("recovery endpoint identity mismatch".into());
        }
        if let SourceIdentity::Local {
            path,
            size,
            dev,
            ino,
        } = &record.source_identity
        {
            let md = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
            if md.file_type().is_symlink() || !md.is_file() || md.len() != *size {
                return Err("recovery source identity mismatch".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if md.dev() != *dev || md.ino() != *ino {
                    return Err("recovery source identity mismatch".into());
                }
            }
            if !local_prefix_matches(Path::new(path), record.bytes, &record.prefix_sha256)? {
                return Err("recovery source prefix hash mismatch".into());
            }
        } else if let SourceIdentity::Remote {
            path,
            size,
            permissions,
        } = &record.source_identity
        {
            let sftp = sftp_common::session_for_binding(&state, &binding).await?;
            let md = sftp
                .symlink_metadata(path)
                .await
                .map_err(|e| e.to_string())?;
            if md.is_symlink()
                || !md.is_regular()
                || md.size != Some(*size)
                || permissions.is_some_and(|mode| md.permissions != Some(mode))
            {
                return Err("recovery source identity mismatch".into());
            }
            if !remote_prefix_matches(&sftp, path, record.bytes, &record.prefix_sha256).await? {
                return Err("recovery source prefix hash mismatch".into());
            }
        }
        let (partial_matches, final_matches) = match &record.partial {
            PartialIdentity::Local { path, .. } => {
                let partial_exists = match fs::symlink_metadata(path) {
                    Ok(_) => true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                    Err(error) => return Err(error.to_string()),
                };
                let partial_matches = if partial_exists {
                    verify_local(&record)?;
                    true
                } else {
                    false
                };
                let final_matches = if record.commit_intent {
                    local_final_matches(&record)?
                } else {
                    false
                };
                (partial_matches, final_matches)
            }
            PartialIdentity::Remote {
                path,
                size,
                permissions,
                endpoint,
            } => {
                if endpoint != &record.endpoint {
                    return Err("remote partial endpoint mismatch".into());
                }
                let sftp = sftp_common::session_for_binding(&state, &binding).await?;
                let partial_matches =
                    remote_file_matches(&sftp, path, *size, &record.prefix_sha256).await?;
                if partial_matches && permissions.is_some() {
                    let metadata = sftp
                        .symlink_metadata(path)
                        .await
                        .map_err(|error| error.to_string())?;
                    if permissions.is_some_and(|mode| metadata.permissions != Some(mode)) {
                        return Err("remote partial permissions mismatch".into());
                    }
                }
                let final_matches = if record.commit_intent {
                    let hash = record
                        .final_sha256
                        .as_deref()
                        .ok_or("commit intent is missing final SHA-256")?;
                    remote_file_matches(&sftp, &record.final_path, record.bytes, hash).await?
                } else {
                    false
                };
                // Direct no-replace uploads atomically create the final path
                // with EXCLUDE. Their durable "partial" and final pathname are
                // intentionally identical; after commit intent the verified
                // path is final, not leftover residue.
                (partial_matches, final_matches)
            }
        };
        let direct_final = record.commit_intent
            && matches!(&record.partial, PartialIdentity::Remote { path, .. } if path == &record.final_path);
        let observation = recovery_observation(partial_matches, final_matches, direct_final)?;
        Ok(RecoveryPreparation {
            record,
            observation,
        })
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Journal, error)
    })
}

/// Reconcile first, then clear only an identity-proven final result. A matching
/// partial keeps the record durable so the UI cannot mistake residue for a
/// completed recovery.
#[tauri::command]
pub async fn ssh_transfer_recovery_reconcile(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    recovery_id: String,
) -> Result<RecoveryReconciliation, String> {
    let preparation =
        ssh_transfer_recovery_prepare(app.clone(), state, binding, recovery_id.clone()).await?;
    let completed = matches!(preparation.observation, RecoveryObservation::FinalMatches);
    if completed {
        transaction(&app, |records| {
            let index = records
                .iter()
                .position(|record| record.recovery_id == recovery_id)
                .ok_or("recovery record changed during reconciliation")?;
            let current = &records[index];
            if !current.paused
                || current.transfer_id != preparation.record.transfer_id
                || current.attempt != preparation.record.attempt
                || current.final_sha256 != preparation.record.final_sha256
            {
                return Err("recovery record changed during reconciliation".into());
            }
            records.remove(index);
            Ok(())
        })
        .map_err(|error| {
            crate::modules::ssh::safe_ipc_error(
                crate::modules::ssh::SshIpcErrorKind::Journal,
                error,
            )
        })?;
    }
    Ok(RecoveryReconciliation {
        record: preparation.record,
        observation: preparation.observation,
        completed,
    })
}

/// Forget a paused recovery record without touching either path. The UI must
/// identify this as an irreversible dismissal, not partial cleanup.
#[tauri::command]
pub fn ssh_transfer_recovery_dismiss(
    app: tauri::AppHandle,
    recovery_id: String,
) -> Result<(), String> {
    transaction(&app, |records| {
        let index = records
            .iter()
            .position(|record| record.recovery_id == recovery_id)
            .ok_or("unknown recovery id")?;
        if !records[index].paused {
            return Err("active recovery record cannot be dismissed".into());
        }
        records.remove(index);
        Ok(())
    })
    .map_err(|error| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::Journal, error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rec(p: &Path) -> TransferJournalRecord {
        TransferJournalRecord {
            recovery_id: "r".into(),
            transfer_id: "t".into(),
            attempt: 1,
            direction: "download".into(),
            session: None,
            endpoint: "e".into(),
            user: "u".into(),
            host_key: "h".into(),
            source: "s".into(),
            source_identity: SourceIdentity::Remote {
                path: "s".into(),
                size: 3,
                permissions: None,
            },
            final_path: "f".into(),
            partial: PartialIdentity::Local {
                path: p.display().to_string(),
                size: 3,
                dev: None,
                ino: None,
            },
            phase: "transferring".into(),
            bytes: 3,
            prefix_sha256: hex(&Sha256::digest(b"abc")),
            final_sha256: None,
            commit_intent: false,
            paused: false,
            needs_reconcile: false,
        }
    }
    #[test]
    fn migration_is_paused_unverified() {
        let mut r = rec(Path::new("x"));
        r.source_identity = SourceIdentity::Unverified;
        r.prefix_sha256 = "bad".into();
        let r = normalize(vec![r]).unwrap().remove(0);
        assert!(r.paused && r.needs_reconcile && r.prefix_sha256.is_empty());
    }

    #[test]
    fn restart_pauses_transferring_and_committing_records() {
        let transferring = rec(Path::new("x"));
        let mut committing = transferring.clone();
        committing.recovery_id = "c".into();
        committing.phase = "committing".into();
        committing.commit_intent = true;
        committing.final_sha256 = Some(committing.prefix_sha256.clone());
        interrupt_records(&mut [transferring.clone(), committing.clone()]);
        let mut records = vec![transferring, committing];
        interrupt_records(&mut records);
        assert!(records
            .iter()
            .all(|r| r.paused && r.needs_reconcile && r.phase == "paused"));
    }

    #[test]
    fn direct_no_replace_commit_is_final_not_residue() {
        assert!(matches!(
            recovery_observation(true, true, true).unwrap(),
            RecoveryObservation::FinalMatches
        ));
        assert!(matches!(
            recovery_observation(true, true, false).unwrap(),
            RecoveryObservation::FinalAndPartialMatch
        ));
    }

    #[test]
    fn prefix_hash_is_the_complete_sha256() {
        let hash = hex(&Sha256::digest(b"prefix"));
        assert_eq!(hash.len(), 64);
        assert!(canonical_hash(&hash));
        assert!(!canonical_hash(&hash[..32]));
    }
    #[test]
    fn hash_mismatch_prevents_delete() {
        let d = std::env::temp_dir().join(format!(".x.tunara-{}.partial", std::process::id()));
        fs::write(&d, b"xyz").unwrap();
        let mut r = rec(&d);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let m = fs::metadata(&d).unwrap();
            r.partial = PartialIdentity::Local {
                path: d.display().to_string(),
                size: 3,
                dev: Some(m.dev()),
                ino: Some(m.ino()),
            };
        }
        assert!(verify_local(&r).is_err());
        assert!(d.exists());
        let _ = fs::remove_file(d);
    }

    #[cfg(unix)]
    #[test]
    fn matching_identity_cannot_authorize_non_tunara_file_delete() {
        use std::os::unix::fs::MetadataExt;
        let path = std::env::temp_dir().join(format!("ordinary-{}", std::process::id()));
        fs::write(&path, b"abc").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let mut record = rec(&path);
        record.partial = PartialIdentity::Local {
            path: path.display().to_string(),
            size: 3,
            dev: Some(metadata.dev()),
            ino: Some(metadata.ino()),
        };
        assert!(securely_delete_local_partial(&record).is_err());
        assert!(path.exists());
        fs::remove_file(path).unwrap();
    }
}
