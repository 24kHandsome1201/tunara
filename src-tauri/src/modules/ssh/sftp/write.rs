use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use russh_sftp::protocol::{FileAttributes, OpenFlags};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    content_fingerprint, remote_sibling_temp_path, validate_remote_edit_path,
    MAX_TEXT_PREVIEW_BYTES, SFTP_CONTROL_TIMEOUT, SFTP_PREVIEW_TIMEOUT,
};
use crate::modules::pty::{PtyState, Session};
use crate::modules::ssh::connection::await_stage;
use crate::modules::ssh::diagnostics::SessionBindingV1;
use crate::modules::ssh::safe_write::{
    write_text_transaction, IoError, RemoteFile, RemoteFileKind, RemoteWriteIo, ReplaceError,
    TransactionOutcome, TransactionStage, WriteRequest,
};
const SFTP_WRITE_TIMEOUT: Duration = Duration::from_secs(60);

const REPLACE_LOCK_STALE_AFTER: Duration = Duration::from_secs(10 * 60);

type RemoteWriteLock = Arc<tokio::sync::Mutex<()>>;

type RemoteWriteLockKey = (u32, String);

type RemoteWriteLockTable = HashMap<RemoteWriteLockKey, Weak<tokio::sync::Mutex<()>>>;

static REMOTE_WRITE_LOCKS: OnceLock<std::sync::Mutex<RemoteWriteLockTable>> = OnceLock::new();

fn remote_write_lock(id: u32, path: &str) -> RemoteWriteLock {
    let locks = REMOTE_WRITE_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Weak entries avoid retaining one mutex forever for every remote path a
    // user has ever edited. Opportunistic pruning keeps the table bounded by
    // currently active paths (plus at most the most recently released entry).
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = (id, path.to_string());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

fn validate_fingerprint(fingerprint: &str) -> Result<(), String> {
    if fingerprint.len() != 64
        || !fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("expected fingerprint must be a lowercase SHA-256 hex digest".into());
    }
    Ok(())
}

fn remote_replace_lock_path(path: &str) -> Result<String, String> {
    let (parsed, _) = validate_remote_edit_path(path)?;
    let parent = parsed
        .parent()
        .ok_or_else(|| "editable path has no parent".to_string())?;
    let target_hash = content_fingerprint(path.as_bytes());
    Ok(parent
        .join(format!(".tunara-write-{target_hash}.lock"))
        .to_string_lossy()
        .into_owned())
}

fn remote_replace_lock_owner_path(path: &str) -> Result<String, String> {
    Ok(Path::new(&remote_replace_lock_path(path)?)
        .join("owner")
        .to_string_lossy()
        .into_owned())
}

async fn read_remote_replace_lock_owner(
    sftp: &russh_sftp::client::SftpSession,
    target: &str,
) -> Result<String, IoError> {
    let owner_path = remote_replace_lock_owner_path(target).map_err(IoError)?;
    let mut file = sftp
        .open(&owner_path)
        .await
        .map_err(|error| IoError(error.to_string()))?;
    let mut bytes = Vec::with_capacity(64);
    (&mut file)
        .take(65)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| IoError(error.to_string()))?;
    if bytes.len() != 64 {
        return Err(IoError("remote replace lock owner is malformed".into()));
    }
    let owner = String::from_utf8(bytes)
        .map_err(|_| IoError("remote replace lock owner is not UTF-8".into()))?;
    validate_fingerprint(&owner).map_err(IoError)?;
    Ok(owner)
}

fn stale_replace_lock_error(lock: &str, age_seconds: u64, owner: Option<&str>) -> IoError {
    let owner = owner.unwrap_or("unknown");
    IoError(format!(
        "remote replace lock appears stale (age={age_seconds}s, owner={owner}); \
         refusing automatic removal; reconcile the interrupted save or verify no writer is active before removing {lock}"
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

async fn read_remote_editable_bytes(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(Vec<u8>, u32), String> {
    validate_remote_edit_path(path)?;
    let metadata = await_stage(
        "lstat editable remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.symlink_metadata(path),
    )
    .await?;
    if metadata.is_symlink() || !metadata.is_regular() {
        return Err("editable path must be a regular file".into());
    }
    if metadata.size.unwrap_or(0) > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable file exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    let mode = metadata
        .permissions
        .ok_or_else(|| "remote server did not report file permissions".to_string())?
        & 0o7777;
    let mut file = await_stage(
        "open editable remote file",
        SFTP_CONTROL_TIMEOUT,
        sftp.open(path),
    )
    .await?;
    let mut bytes = Vec::with_capacity(metadata.size.unwrap_or(0) as usize);
    await_stage(
        "read editable remote file",
        SFTP_PREVIEW_TIMEOUT,
        (&mut file)
            .take(MAX_TEXT_PREVIEW_BYTES + 1)
            .read_to_end(&mut bytes),
    )
    .await?;
    if bytes.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable file exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) || std::str::from_utf8(&bytes).is_err() {
        return Err("editable file must be UTF-8 text".into());
    }
    Ok((bytes, mode))
}

/// Optimistic conflict-aware remote text save. Changes observed by the final
/// validation are rejected; an uncooperative writer can still race publication.
/// SFTP prepares a create-new sibling with the original mode and drains all
/// write acknowledgements. The final `mv` runs on
/// the same SSH connection because russh-sftp 2.3 does not expose OpenSSH's
/// posix-rename extension; on the supported Unix hosts, same-directory `mv`
/// delegates to atomic rename without ever removing the destination first.
#[tauri::command]
pub async fn ssh_fs_write_text_file(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
    content: String,
    expected_fingerprint: String,
) -> Result<crate::modules::fs::file::WriteResult, String> {
    (async {
    if content.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        return Err(format!(
            "editable content exceeds {MAX_TEXT_PREVIEW_BYTES} bytes"
        ));
    }
    validate_fingerprint(&expected_fingerprint)?;
    validate_remote_edit_path(&path)?;
    // Serialize saves issued by this app for the same remote path. The second
    // caller must re-read after the first commits and report a conflict instead
    // of letting two equal fingerprints both pass the pre-rename check.
    let write_lock = remote_write_lock(binding.physical_pty_id, &path);
    let session = state
        .get_for_ssh_binding(&binding)
        .ok_or_else(|| "stale or invalid SSH session binding".to_string())?;
    let ssh = match session.as_ref() {
        Session::Ssh(ssh) => ssh,
        Session::Local(_) => return Err("not a remote session".into()),
    };
    let sftp = ssh.sftp().await?;
    let adapter = SftpWriteAdapter::new_bound(
        &sftp,
        ssh,
        state.inner(),
        &binding,
        binding.physical_pty_id,
    );
    let mut outcome = None;
    for attempt in 0..16 {
        let temporary = remote_sibling_temp_path(&path, attempt)?;
        match write_text_transaction(
            &adapter,
            write_lock.as_ref(),
            WriteRequest {
                target: &path,
                temporary: &temporary,
                content: content.as_bytes(),
                expected_fingerprint: &expected_fingerprint,
            },
        )
        .await
        {
            Err(error)
                if error.stage == TransactionStage::Create
                    && error.source.to_ascii_lowercase().contains("exist") =>
            {
                continue;
            }
            result => {
                outcome = Some(result);
                break;
            }
        }
    }
    let outcome = outcome
        .ok_or_else(|| "could not allocate remote temporary file after 16 attempts".to_string())?
        .map_err(|error| error.to_string())?;
    match outcome {
        TransactionOutcome::Saved { fingerprint, size } => {
            Ok(crate::modules::fs::file::WriteResult::Saved { fingerprint, size })
        }
        TransactionOutcome::Conflict { current_fingerprint, .. } => {
            Ok(crate::modules::fs::file::WriteResult::Conflict { current_fingerprint })
        }
        TransactionOutcome::OutcomeUnknown {
            attempted_fingerprint,
            expected_mode,
            replace_lock_owner,
            cleanup_pending,
        } => Err(format!(
            "outcomeUnknown:{attempted_fingerprint}:{expected_mode:o}:lockOwner={replace_lock_owner}:cleanupPending={cleanup_pending}"
        )),
    }

    }).await.map_err(|error: String| crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpWrite, error))
}

struct SftpWriteAdapter<'a> {
    sftp: &'a russh_sftp::client::SftpSession,
    ssh: &'a super::super::connection::SshSession,
    binding_guard: Option<(&'a PtyState, &'a SessionBindingV1)>,
    commit_lease: std::sync::Mutex<Option<crate::modules::pty::CommitLease>>,
    #[cfg(feature = "m2-safe-write-benchmark")]
    session_id: u32,
    #[cfg(test)]
    replace_request_hook: Option<Arc<dyn Fn() + Send + Sync>>,
    #[cfg(test)]
    replace_response_delay: Option<Duration>,
}

impl<'a> SftpWriteAdapter<'a> {
    #[cfg(test)]
    fn new(
        sftp: &'a russh_sftp::client::SftpSession,
        ssh: &'a super::super::connection::SshSession,
        #[cfg_attr(not(feature = "m2-safe-write-benchmark"), allow(unused_variables))]
        session_id: u32,
    ) -> Self {
        Self {
            sftp,
            ssh,
            binding_guard: None,
            commit_lease: std::sync::Mutex::new(None),
            #[cfg(feature = "m2-safe-write-benchmark")]
            session_id,
            #[cfg(test)]
            replace_request_hook: None,
            #[cfg(test)]
            replace_response_delay: None,
        }
    }

    fn new_bound(
        sftp: &'a russh_sftp::client::SftpSession,
        ssh: &'a super::super::connection::SshSession,
        state: &'a PtyState,
        binding: &'a SessionBindingV1,
        #[cfg_attr(not(feature = "m2-safe-write-benchmark"), allow(unused_variables))]
        session_id: u32,
    ) -> Self {
        Self {
            sftp,
            ssh,
            binding_guard: Some((state, binding)),
            commit_lease: std::sync::Mutex::new(None),
            #[cfg(feature = "m2-safe-write-benchmark")]
            session_id,
            #[cfg(test)]
            replace_request_hook: None,
            #[cfg(test)]
            replace_response_delay: None,
        }
    }

    #[cfg(test)]
    fn with_replace_test_probe(
        mut self,
        hook: Arc<dyn Fn() + Send + Sync>,
        response_delay: Duration,
    ) -> Self {
        self.replace_request_hook = Some(hook);
        self.replace_response_delay = Some(response_delay);
        self
    }
}

impl RemoteWriteIo for SftpWriteAdapter<'_> {
    type Temp = russh_sftp::client::fs::File;

    async fn read_regular(&self, path: &str) -> Result<RemoteFile, IoError> {
        read_remote_editable_bytes(self.sftp, path)
            .await
            .map(|(bytes, mode)| RemoteFile {
                bytes,
                mode,
                kind: RemoteFileKind::Regular,
            })
            .map_err(IoError)
    }

    async fn create_exclusive(&self, path: &str, mode: u32) -> Result<Self::Temp, IoError> {
        await_stage(
            "create remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            self.sftp.open_with_flags_and_attributes(
                path,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(mode),
                    ..FileAttributes::empty()
                },
            ),
        )
        .await
        .map_err(IoError)
    }

    async fn write_all(&self, temporary: &mut Self::Temp, bytes: &[u8]) -> Result<(), IoError> {
        await_stage(
            "write remote temporary file",
            SFTP_WRITE_TIMEOUT,
            temporary.write_all(bytes),
        )
        .await
        .map_err(IoError)
    }
    async fn flush(&self, temporary: &mut Self::Temp) -> Result<(), IoError> {
        await_stage(
            "flush remote temporary file",
            SFTP_WRITE_TIMEOUT,
            temporary.flush(),
        )
        .await
        .map_err(IoError)
    }
    async fn set_mode(&self, temporary: &mut Self::Temp, mode: u32) -> Result<(), IoError> {
        await_stage(
            "set remote temporary permissions",
            SFTP_CONTROL_TIMEOUT,
            temporary.set_metadata(FileAttributes {
                permissions: Some(mode),
                ..FileAttributes::empty()
            }),
        )
        .await
        .map_err(IoError)
    }
    async fn sync(&self, temporary: &mut Self::Temp) -> Result<(), IoError> {
        await_stage(
            "sync remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            temporary.sync_all(),
        )
        .await
        .map_err(IoError)
    }
    async fn close(&self, mut temporary: Self::Temp) -> Result<(), IoError> {
        await_stage(
            "close remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            temporary.shutdown(),
        )
        .await
        .map_err(IoError)
    }
    async fn acquire_replace_lock(&self, target: &str, owner: &str) -> Result<(), IoError> {
        validate_fingerprint(owner).map_err(IoError)?;
        let lock = remote_replace_lock_path(target).map_err(IoError)?;
        let owner_path = remote_replace_lock_owner_path(target).map_err(IoError)?;
        let deadline = tokio::time::Instant::now() + SFTP_CONTROL_TIMEOUT;
        let mut stale_checked = false;
        loop {
            match self.sftp.create_dir(lock.clone()).await {
                Ok(()) => {
                    let result = async {
                        let mut marker = self
                            .sftp
                            .open_with_flags_and_attributes(
                                owner_path.clone(),
                                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                                FileAttributes {
                                    permissions: Some(0o600),
                                    ..FileAttributes::empty()
                                },
                            )
                            .await
                            .map_err(|error| IoError(error.to_string()))?;
                        marker
                            .write_all(owner.as_bytes())
                            .await
                            .map_err(|error| IoError(error.to_string()))?;
                        marker
                            .shutdown()
                            .await
                            .map_err(|error| IoError(error.to_string()))
                    }
                    .await;
                    if let Err(error) = result {
                        let _ = self.sftp.remove_file(owner_path.clone()).await;
                        let _ = self.sftp.remove_dir(lock.clone()).await;
                        return Err(error);
                    }
                    return Ok(());
                }
                Err(source) => {
                    let message = source.to_string();
                    let lower = message.to_ascii_lowercase();
                    if lower.contains("permission")
                        || lower.contains("denied")
                        || lower.contains("no such")
                    {
                        return Err(IoError(format!(
                            "acquire remote replace lock failed: {message}"
                        )));
                    }
                    if !stale_checked {
                        stale_checked = true;
                        let age_seconds = self
                            .sftp
                            .metadata(lock.clone())
                            .await
                            .ok()
                            .and_then(|metadata| metadata.mtime)
                            .and_then(|mtime| {
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .ok()
                                    .map(|now| now.as_secs().saturating_sub(u64::from(mtime)))
                            });
                        if let Some(age_seconds) =
                            age_seconds.filter(|age| *age >= REPLACE_LOCK_STALE_AFTER.as_secs())
                        {
                            // A stat/delete/recreate sequence cannot compare a
                            // lock generation atomically over portable SFTP. An
                            // active writer could replace the directory after
                            // our stat and then have its new lock deleted here.
                            // Fail closed and leave owner-aware reconciliation
                            // (or explicit operator cleanup) as the recovery
                            // path instead of risking two successful writers.
                            let owner = tokio::time::timeout(
                                SFTP_CONTROL_TIMEOUT,
                                read_remote_replace_lock_owner(self.sftp, target),
                            )
                            .await
                            .ok()
                            .and_then(Result::ok);
                            return Err(stale_replace_lock_error(
                                &lock,
                                age_seconds,
                                owner.as_deref(),
                            ));
                        }
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(IoError(format!(
                            "remote replace lock stayed busy for {}s: {message}",
                            SFTP_CONTROL_TIMEOUT.as_secs()
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
            }
        }
    }
    async fn release_replace_lock(&self, target: &str, owner: &str) -> Result<(), IoError> {
        validate_fingerprint(owner).map_err(IoError)?;
        #[cfg(feature = "m2-safe-write-benchmark")]
        if super::super::m2_safe_write_benchmark::take_release_failure(self.session_id, target) {
            return Err(IoError(
                "isolated M2 benchmark injected a one-shot release failure".into(),
            ));
        }
        let result = async {
            let lock = remote_replace_lock_path(target).map_err(IoError)?;
            let owner_path = remote_replace_lock_owner_path(target).map_err(IoError)?;
            let observed = read_remote_replace_lock_owner(self.sftp, target).await?;
            if observed != owner {
                return Err(IoError("remote replace lock owner changed".into()));
            }
            await_stage(
                "remove remote replace lock owner",
                SFTP_CONTROL_TIMEOUT,
                self.sftp.remove_file(owner_path),
            )
            .await
            .map_err(IoError)?;
            await_stage(
                "release remote replace lock",
                SFTP_CONTROL_TIMEOUT,
                self.sftp.remove_dir(lock),
            )
            .await
            .map_err(IoError)
        }
        .await;
        self.commit_lease
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        result
    }
    async fn atomic_replace(&self, temporary: &str, target: &str) -> Result<(), ReplaceError> {
        if let Some((state, binding)) = self.binding_guard {
            let lease = state
                .acquire_commit_lease(binding)
                .map_err(ReplaceError::NotSent)?;
            let mut held = self
                .commit_lease
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if held.is_some() {
                return Err(ReplaceError::NotSent(
                    "remote write commit lease is already held".into(),
                ));
            }
            *held = Some(lease);
        }
        let command = format!(
            "mv -f -- {} {}",
            shell_quote(temporary),
            shell_quote(target)
        );
        #[cfg(test)]
        let command = self
            .replace_response_delay
            .map(|delay| format!("{command} && sleep {}", delay.as_secs()))
            .unwrap_or(command);
        #[cfg(test)]
        if let Some(hook) = self.replace_request_hook.as_deref() {
            return self
                .ssh
                .exec_with_test_request_hook(&command, 16 * 1024, hook)
                .await
                .map(|_| ())
                .map_err(ReplaceError::StatusLost);
        }
        self.ssh
            .exec(&command, 16 * 1024)
            .await
            .map(|_| ())
            .map_err(ReplaceError::StatusLost)
    }
    async fn remove_temp(&self, path: &str) -> Result<(), IoError> {
        await_stage(
            "remove remote temporary file",
            SFTP_CONTROL_TIMEOUT,
            self.sftp.remove_file(path),
        )
        .await
        .map_err(IoError)
    }
}

async fn cleanup_owned_write_residue(
    sftp: &russh_sftp::client::SftpSession,
    target: &str,
    owner: &str,
) -> Result<(), String> {
    validate_fingerprint(owner)?;
    let (parsed, name) = validate_remote_edit_path(target)?;
    let parent = parsed
        .parent()
        .ok_or_else(|| "editable path has no parent".to_string())?;
    let prefix = format!(".{name}.tunara-");
    let entries = await_stage(
        "list remote write residue",
        SFTP_CONTROL_TIMEOUT,
        sftp.read_dir(parent.to_string_lossy().into_owned()),
    )
    .await?;
    for entry in entries {
        let file_name = entry.file_name();
        if file_name.starts_with(&prefix)
            && file_name.ends_with(".tmp")
            && content_fingerprint(entry.path().as_bytes()) == owner
        {
            await_stage(
                "remove owned remote temporary file",
                SFTP_CONTROL_TIMEOUT,
                sftp.remove_file(entry.path()),
            )
            .await?;
        }
    }

    let lock = remote_replace_lock_path(target)?;
    if sftp.metadata(lock.clone()).await.is_ok() {
        let observed_owner = read_remote_replace_lock_owner(sftp, target)
            .await
            .map_err(|error| error.0)?;
        if observed_owner != owner {
            return Err("remote replace lock belongs to another transaction".into());
        }
        let owner_path = remote_replace_lock_owner_path(target)?;
        await_stage(
            "remove owned remote replace lock marker",
            SFTP_CONTROL_TIMEOUT,
            sftp.remove_file(owner_path),
        )
        .await?;
        await_stage(
            "remove owned remote replace lock",
            SFTP_CONTROL_TIMEOUT,
            sftp.remove_dir(lock),
        )
        .await?;
    }
    Ok(())
}

/// Reconcile an indeterminate replace after reconnect. Bytes alone are not
/// sufficient: permission preservation is part of the save contract, so the
/// caller must return the mode encoded in the outcomeUnknown token.
#[tauri::command]
pub async fn ssh_fs_reconcile_text_write(
    state: tauri::State<'_, PtyState>,
    binding: SessionBindingV1,
    path: String,
    attempted_fingerprint: String,
    expected_mode: u32,
    replace_lock_owner: String,
) -> Result<crate::modules::fs::file::WriteResult, String> {
    (async {
        let sftp = super::super::sftp_common::session_for_binding(state.inner(), &binding).await?;
        // Reconciliation removes transaction-owned remote residue. Keep the
        // exact generation authoritative from the final observation through
        // cleanup so a reconnect cannot turn this into a mutation on a retired
        // connection.
        let _lease = state.acquire_commit_lease(&binding)?;
        reconcile_text_write_with_sftp(
            &sftp,
            &path,
            &attempted_fingerprint,
            expected_mode,
            &replace_lock_owner,
        )
        .await
    })
    .await
    .map_err(|error: String| {
        crate::modules::ssh::safe_ipc_error(crate::modules::ssh::SshIpcErrorKind::SftpWrite, error)
    })
}

async fn reconcile_text_write_with_sftp(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    attempted_fingerprint: &str,
    expected_mode: u32,
    replace_lock_owner: &str,
) -> Result<crate::modules::fs::file::WriteResult, String> {
    validate_fingerprint(attempted_fingerprint)?;
    validate_fingerprint(replace_lock_owner)?;
    validate_remote_edit_path(path)?;
    if expected_mode > 0o7777 {
        return Err("reconcile mode must fit Unix permission bits".into());
    }
    let (observed, observed_mode) = read_remote_editable_bytes(sftp, path).await?;
    let current_fingerprint = content_fingerprint(&observed);
    let result = if current_fingerprint == attempted_fingerprint && observed_mode == expected_mode {
        Ok(crate::modules::fs::file::WriteResult::Saved {
            fingerprint: current_fingerprint,
            size: observed.len() as u64,
        })
    } else {
        Ok(crate::modules::fs::file::WriteResult::Conflict {
            current_fingerprint,
        })
    };
    cleanup_owned_write_residue(sftp, path, replace_lock_owner).await?;
    result
}

// Cap a single download so a malicious/compromised remote can't exhaust memory
// (whole file is buffered before writing). 100 MiB is generous for a file
// browser's download affordance.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pty::PtyEvent;
    use crate::modules::ssh::auth::AuthOptions;
    use crate::modules::ssh::connection::{ConnectParams, HostKeyPolicy, SshSession};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::ipc::Channel;
    #[test]
    fn stale_remote_replace_locks_fail_closed_with_recovery_context() {
        let owner = "a".repeat(64);
        let error = stale_replace_lock_error("/srv/.tunara.lock", 601, Some(&owner));
        assert!(error.0.contains("appears stale"));
        assert!(error.0.contains(&format!("owner={owner}")));
        assert!(error.0.contains("refusing automatic removal"));
        assert!(error.0.contains("/srv/.tunara.lock"));

        let unknown = stale_replace_lock_error("/srv/.tunara.lock", 601, None);
        assert!(unknown.0.contains("owner=unknown"));
    }

    // The validator confines downloads under the *real* home dir, so test
    // fixtures must be created inside home (temp_dir() lives outside home on
    // macOS, which is itself a useful negative case).
    async fn open_real_ssh_session(label: &str) -> SshSession {
        let host = std::env::var("TUNARA_SSH_SMOKE_HOST")
            .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
        let port = std::env::var("TUNARA_SSH_SMOKE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        open_ssh_session_at(host, port, HostKeyPolicy::AcceptUnknown, label).await
    }

    async fn open_ssh_session_at(
        host: String,
        port: u16,
        policy: HostKeyPolicy,
        label: &str,
    ) -> SshSession {
        let user = std::env::var("TUNARA_SSH_SMOKE_USER").unwrap_or_else(|_| "root".into());
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            SshSession::open(
                ConnectParams {
                    host,
                    port,
                    auth: AuthOptions {
                        user,
                        method: crate::modules::ssh::auth::AuthMethod::Agent,
                        identity_file: None,
                        certificate_file: None,
                        key_passphrase: None,
                        password: None,
                    },
                    policy,
                    cols: 80,
                    rows: 24,
                    initial_cwd: None,
                    inject_shell_integration: false,
                    session_id: label.into(),
                    transport_generation: "smoke".into(),
                    hop_role: "direct".into(),
                    jump_endpoint: None,
                },
                Channel::<PtyEvent>::new(|_| Ok(())),
            ),
        )
        .await
        .expect("SSH open timeout")
        .expect("SSH open")
    }

    struct ProxyControl {
        hold_server_output: Arc<std::sync::atomic::AtomicBool>,
        cut: std::sync::mpsc::Sender<()>,
    }

    fn spawn_controlled_tcp_proxy(target_host: String, target_port: u16) -> (u16, ProxyControl) {
        use std::io::{Read, Write};
        use std::net::{Shutdown, TcpListener, TcpStream};
        use std::sync::atomic::Ordering;

        fn relay(
            mut reader: TcpStream,
            mut writer: TcpStream,
            hold: Option<Arc<std::sync::atomic::AtomicBool>>,
        ) {
            let mut buffer = [0u8; 64 * 1024];
            loop {
                let count = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => count,
                };
                while hold
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Acquire))
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                if writer.write_all(&buffer[..count]).is_err() {
                    break;
                }
            }
            let _ = writer.shutdown(Shutdown::Write);
        }

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind controlled SSH proxy");
        let port = listener.local_addr().expect("proxy address").port();
        let hold_server_output = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let relay_hold = hold_server_output.clone();
        let (cut_tx, cut_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("tunara-ssh-cut-proxy".into())
            .spawn(move || {
                let (client, _) = listener.accept().expect("accept controlled SSH client");
                let upstream = TcpStream::connect((target_host.as_str(), target_port))
                    .expect("connect controlled SSH upstream");
                client.set_nodelay(true).ok();
                upstream.set_nodelay(true).ok();
                let cut_client = client.try_clone().expect("clone cut client");
                let cut_upstream = upstream.try_clone().expect("clone cut upstream");
                std::thread::spawn(move || {
                    let _ = cut_rx.recv();
                    let _ = cut_client.shutdown(Shutdown::Both);
                    let _ = cut_upstream.shutdown(Shutdown::Both);
                });
                let client_read = client.try_clone().expect("clone proxy client");
                let upstream_read = upstream.try_clone().expect("clone proxy upstream");
                let forward = std::thread::spawn(move || relay(client_read, upstream, None));
                relay(upstream_read, client, Some(relay_hold));
                forward.join().ok();
            })
            .expect("spawn controlled SSH proxy");
        (
            port,
            ProxyControl {
                hold_server_output,
                cut: cut_tx,
            },
        )
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and an authorized SSH key"]
    async fn real_ssh_safe_write_adapter_preserves_content_mode_and_conflicts() {
        let session = open_real_ssh_session("m2-safe-write-live").await;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = format!("/tmp/tunara-m2-safe-write-{unique}");
        let target = format!("{directory}/配置 file.md");
        session
            .exec(
                &format!(
                    "install -d -m 700 {} && printf 'before\\n' > {} && chmod 640 {}",
                    shell_quote(&directory),
                    shell_quote(&target),
                    shell_quote(&target),
                ),
                16 * 1024,
            )
            .await
            .expect("create isolated remote fixture");

        let sftp = session.sftp().await.expect("open SFTP");
        let adapter = SftpWriteAdapter::new(&sftp, &session, 0);
        let initial = adapter.read_regular(&target).await.expect("read initial");
        assert_eq!(initial.bytes, b"before\n");
        assert_eq!(initial.mode, 0o640);
        let initial_fingerprint = super::content_fingerprint(&initial.bytes);
        let temporary = format!("{directory}/.配置 file.md.tunara-live.tmp");
        let lock = tokio::sync::Mutex::new(());
        let saved = write_text_transaction(
            &adapter,
            &lock,
            WriteRequest {
                target: &target,
                temporary: &temporary,
                content: b"after\n",
                expected_fingerprint: &initial_fingerprint,
            },
        )
        .await
        .expect("save transaction");
        assert!(matches!(saved, TransactionOutcome::Saved { .. }));
        let observed = adapter.read_regular(&target).await.expect("read saved");
        assert_eq!(observed.bytes, b"after\n");
        assert_eq!(observed.mode, 0o640);

        session
            .exec(
                &format!(
                    "printf 'other\\n' > {} && chmod 640 {}",
                    shell_quote(&target),
                    shell_quote(&target)
                ),
                16 * 1024,
            )
            .await
            .expect("external same-size rewrite");
        let conflict_temp = format!("{directory}/.配置 file.md.tunara-conflict.tmp");
        let conflict = write_text_transaction(
            &adapter,
            &lock,
            WriteRequest {
                target: &target,
                temporary: &conflict_temp,
                content: b"draft\n",
                expected_fingerprint: &super::content_fingerprint(b"after\n"),
            },
        )
        .await
        .expect("conflict transaction");
        assert!(matches!(conflict, TransactionOutcome::Conflict { .. }));
        let after_conflict = adapter
            .read_regular(&target)
            .await
            .expect("read conflict target");
        assert_eq!(after_conflict.bytes, b"other\n");
        assert_eq!(after_conflict.mode, 0o640);

        let residue = session
        .exec(
            &format!(
                "find {} -maxdepth 1 \\( -name '*.tunara-*.tmp' -o -name '.tunara-write-*.lock' \\) -print; rm -rf -- {}",
                shell_quote(&directory),
                shell_quote(&directory),
            ),
            16 * 1024,
        )
        .await
        .expect("inspect residue and clean fixture");
        assert!(residue.trim().is_empty(), "temporary residue: {residue:?}");
        session.close().expect("close SSH session");
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and an authorized SSH key"]
    async fn real_ssh_replace_status_loss_reconciles_saved_on_a_fresh_connection() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let target_host = std::env::var("TUNARA_SSH_SMOKE_HOST")
            .expect("set TUNARA_SSH_SMOKE_HOST to an authorized test host");
        let target_port = std::env::var("TUNARA_SSH_SMOKE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(22);
        let (proxy_port, proxy) = spawn_controlled_tcp_proxy(target_host, target_port);
        let (proxied, control) = tokio::join!(
            open_ssh_session_at(
                "127.0.0.1".into(),
                proxy_port,
                HostKeyPolicy::AcceptForTest,
                "m2-status-loss-proxied",
            ),
            open_real_ssh_session("m2-status-loss-control"),
        );
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = format!("/tmp/tunara-m2-status-loss-{unique}");
        let target = format!("{directory}/配置 file.md");
        control
            .exec(
                &format!(
                    "install -d -m 700 {} && printf 'before\\n' > {} && chmod 640 {}",
                    shell_quote(&directory),
                    shell_quote(&target),
                    shell_quote(&target),
                ),
                16 * 1024,
            )
            .await
            .expect("create status-loss fixture");

        let proxied_sftp = proxied.sftp().await.expect("open proxied SFTP");
        let control_sftp = control.sftp().await.expect("open control SFTP");
        let request_accepted = Arc::new(AtomicBool::new(false));
        let request_signal = request_accepted.clone();
        let hold = proxy.hold_server_output.clone();
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            hold.store(true, Ordering::Release);
            request_signal.store(true, Ordering::Release);
        });
        let adapter = SftpWriteAdapter::new(&proxied_sftp, &proxied, 0)
            .with_replace_test_probe(hook, std::time::Duration::from_secs(3));
        let temporary = format!("{directory}/.配置 file.md.tunara-status-loss.tmp");
        let expected = super::content_fingerprint(b"before\n");
        let attempted = super::content_fingerprint(b"after\n");
        let replace_lock_owner = super::content_fingerprint(temporary.as_bytes());
        let lock = tokio::sync::Mutex::new(());
        let transaction = write_text_transaction(
            &adapter,
            &lock,
            WriteRequest {
                target: &target,
                temporary: &temporary,
                content: b"after\n",
                expected_fingerprint: &expected,
            },
        );
        let observe_and_cut = async {
            tokio::time::timeout(std::time::Duration::from_secs(10), async {
                while !request_accepted.load(Ordering::Acquire) {
                    tokio::task::yield_now().await;
                }
                loop {
                    if let Ok((bytes, mode)) =
                        read_remote_editable_bytes(&control_sftp, &target).await
                    {
                        if bytes == b"after\n" && mode == 0o640 {
                            break;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("remote replace became visible before cut");
            proxy.cut.send(()).expect("cut proxied TCP connection");
        };
        let (outcome, ()) = tokio::join!(transaction, observe_and_cut);
        assert!(matches!(
            outcome.expect("status-loss transaction"),
            TransactionOutcome::OutcomeUnknown {
                expected_mode: 0o640,
                cleanup_pending: true,
                ..
            }
        ));

        let residue_command = format!(
            "find {} -maxdepth 1 \\( -name '*.tmp' -o -name '.tunara-write-*.lock' \\) -print",
            shell_quote(&directory),
        );
        let before_cleanup = control
            .exec(&residue_command, 16 * 1024)
            .await
            .expect("inspect residue before reconcile");
        assert!(
            !before_cleanup.trim().is_empty(),
            "a severed connection should leave owner-scoped cleanup work"
        );
        let reconciled = reconcile_text_write_with_sftp(
            &control_sftp,
            &target,
            &attempted,
            0o640,
            &replace_lock_owner,
        )
        .await
        .expect("reconcile over fresh connection");
        assert!(matches!(
            reconciled,
            crate::modules::fs::file::WriteResult::Saved { .. }
        ));
        let residue = control
            .exec(&residue_command, 16 * 1024)
            .await
            .expect("inspect status-loss residue after reconcile");
        assert!(
            residue.trim().is_empty(),
            "reconcile left owned residue: {residue:?}"
        );
        let alien_owner = "c".repeat(64);
        let lock_path = remote_replace_lock_path(&target).expect("lock path");
        let owner_path = remote_replace_lock_owner_path(&target).expect("owner path");
        control
            .exec(
                &format!(
                    "mkdir -- {} && printf '%s' {} > {}",
                    shell_quote(&lock_path),
                    shell_quote(&alien_owner),
                    shell_quote(&owner_path),
                ),
                16 * 1024,
            )
            .await
            .expect("create another transaction's lock");
        let mismatch = reconcile_text_write_with_sftp(
            &control_sftp,
            &target,
            &attempted,
            0o640,
            &replace_lock_owner,
        )
        .await
        .expect_err("must not clean another transaction's lock");
        assert!(mismatch.contains("belongs to another transaction"));
        let alien_still_present = control
            .exec(
                &format!(
                    "test -f {} && cat {}; rm -rf -- {}",
                    shell_quote(&owner_path),
                    shell_quote(&owner_path),
                    shell_quote(&directory),
                ),
                16 * 1024,
            )
            .await
            .expect("verify alien lock and clean fixture");
        assert_eq!(alien_still_present, alien_owner);
        control.close().expect("close control SSH session");
    }

    #[tokio::test]
    #[ignore = "requires TUNARA_SSH_SMOKE_HOST and an authorized SSH key"]
    async fn real_ssh_independent_clients_allow_at_most_one_stale_fingerprint_save() {
        let (session_a, session_b) = tokio::join!(
            open_real_ssh_session("m2-race-a"),
            open_real_ssh_session("m2-race-b"),
        );
        let sftp_a = session_a.sftp().await.expect("open first SFTP");
        let sftp_b = session_b.sftp().await.expect("open second SFTP");
        let adapter_a = SftpWriteAdapter::new(&sftp_a, &session_a, 0);
        let adapter_b = SftpWriteAdapter::new(&sftp_b, &session_b, 0);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = format!("/tmp/tunara-m2-race-{unique}");
        session_a
            .exec(
                &format!("install -d -m 700 {}", shell_quote(&directory)),
                4096,
            )
            .await
            .expect("create race directory");

        for round in 0..12 {
            let target = format!("{directory}/race-{round}.md");
            session_a
                .exec(
                    &format!(
                        "printf 'base\\n' > {} && chmod 640 {}",
                        shell_quote(&target),
                        shell_quote(&target)
                    ),
                    4096,
                )
                .await
                .expect("create race target");
            let fingerprint = super::content_fingerprint(b"base\n");
            let temporary_a = format!("{directory}/.race-{round}.a.tmp");
            let temporary_b = format!("{directory}/.race-{round}.b.tmp");
            let lock_a = tokio::sync::Mutex::new(());
            let lock_b = tokio::sync::Mutex::new(());
            let request_a = WriteRequest {
                target: &target,
                temporary: &temporary_a,
                content: b"from-a\n",
                expected_fingerprint: &fingerprint,
            };
            let request_b = WriteRequest {
                target: &target,
                temporary: &temporary_b,
                content: b"from-b\n",
                expected_fingerprint: &fingerprint,
            };
            let (outcome_a, outcome_b) = tokio::join!(
                write_text_transaction(&adapter_a, &lock_a, request_a),
                write_text_transaction(&adapter_b, &lock_b, request_b),
            );
            let outcomes = [
                outcome_a.expect("first transaction"),
                outcome_b.expect("second transaction"),
            ];
            let saved = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, TransactionOutcome::Saved { .. }))
                .count();
            let conflicts = outcomes
                .iter()
                .filter(|outcome| matches!(outcome, TransactionOutcome::Conflict { .. }))
                .count();
            assert_eq!(saved, 1, "round {round} outcomes: {outcomes:?}");
            assert_eq!(conflicts, 1, "round {round} outcomes: {outcomes:?}");
        }

        let residue = session_a
        .exec(
            &format!(
                "find {} -maxdepth 1 \\( -name '*.tmp' -o -name '.tunara-write-*.lock' \\) -print; rm -rf -- {}",
                shell_quote(&directory),
                shell_quote(&directory),
            ),
            16 * 1024,
        )
        .await
        .expect("inspect race residue and clean fixture");
        assert!(residue.trim().is_empty(), "temporary residue: {residue:?}");
        session_a.close().expect("close first SSH session");
        session_b.close().expect("close second SSH session");
    }

    #[test]
    fn replace_lock_is_a_fixed_length_hidden_sibling_scoped_to_the_full_target() {
        let first = remote_replace_lock_path("/srv/app/可爱 animal.md").expect("first lock");
        let same = remote_replace_lock_path("/srv/app/可爱 animal.md").expect("same lock");
        let other = remote_replace_lock_path("/srv/app/other.md").expect("other lock");
        assert_eq!(first, same);
        assert_ne!(first, other);
        assert_eq!(Path::new(&first).parent(), Some(Path::new("/srv/app")));
        assert!(Path::new(&first)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".tunara-write-") && name.ends_with(".lock")));
    }

    #[test]
    fn shell_quote_keeps_spaces_unicode_and_quotes_in_one_argument() {
        assert_eq!(shell_quote("/a/可爱 animal.md"), "'/a/可爱 animal.md'");
        assert_eq!(shell_quote("/a/o'brien.md"), "'/a/o'\"'\"'brien.md'");
    }

    #[test]
    fn save_fingerprint_must_be_canonical_sha256_hex() {
        assert!(validate_fingerprint(&"a".repeat(64)).is_ok());
        for invalid in ["", "abc", &"A".repeat(64), &"g".repeat(64)] {
            assert!(validate_fingerprint(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn concurrent_saves_for_one_remote_path_are_serialized() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        let lock = remote_write_lock(9_001, "/tmp/concurrent.txt");
        assert!(Arc::ptr_eq(
            &lock,
            &remote_write_lock(9_001, "/tmp/concurrent.txt")
        ));
        assert!(!Arc::ptr_eq(
            &lock,
            &remote_write_lock(9_002, "/tmp/concurrent.txt")
        ));

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let lock = lock.clone();
            let active = active.clone();
            let peak = peak.clone();
            tasks.push(tokio::spawn(async move {
                let _guard = lock.lock().await;
                let now = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                peak.fetch_max(now, AtomicOrdering::SeqCst);
                tokio::task::yield_now().await;
                active.fetch_sub(1, AtomicOrdering::SeqCst);
            }));
        }
        for task in tasks {
            task.await.expect("save task");
        }
        assert_eq!(peak.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn released_remote_write_locks_are_pruned_on_the_next_lookup() {
        let first = remote_write_lock(9_101, "/tmp/released-a.txt");
        drop(first);
        let _second = remote_write_lock(9_101, "/tmp/released-b.txt");
        let locks = REMOTE_WRITE_LOCKS
            .get()
            .expect("lock table")
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!locks.contains_key(&(9_101, "/tmp/released-a.txt".to_string())));
    }
}
