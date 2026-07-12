use sha2::{Digest, Sha256};
use std::fmt;
use tokio::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum RemoteFileKind {
    Regular,
    Symlink,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RemoteFile {
    pub bytes: Vec<u8>,
    pub mode: u32,
    pub kind: RemoteFileKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IoError(pub String);

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum ReplaceError {
    NotSent(String),
    Unsupported(String),
    StatusLost(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransactionStage {
    InitialRead,
    Create,
    Write,
    Flush,
    SetMode,
    Sync,
    Close,
    AcquireReplaceLock,
    PreReplaceRead,
    Replace,
    Verify,
    ReleaseReplaceLock,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TransactionError {
    pub stage: TransactionStage,
    pub source: String,
    pub cleanup_pending: bool,
}

impl fmt::Display for TransactionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.stage, self.source)?;
        if self.cleanup_pending {
            write!(formatter, " (temporary cleanup pending)")?;
        }
        Ok(())
    }
}

impl std::error::Error for TransactionError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TransactionOutcome {
    Saved {
        fingerprint: String,
        size: u64,
    },
    Conflict {
        current_fingerprint: String,
        cleanup_pending: bool,
    },
    OutcomeUnknown {
        attempted_fingerprint: String,
        expected_mode: u32,
        cleanup_pending: bool,
    },
}

pub(crate) struct WriteRequest<'a> {
    pub target: &'a str,
    pub temporary: &'a str,
    pub content: &'a [u8],
    pub expected_fingerprint: &'a str,
}

pub(crate) trait RemoteWriteIo: Sync {
    type Temp: Send;

    async fn read_regular(&self, path: &str) -> Result<RemoteFile, IoError>;
    async fn create_exclusive(&self, path: &str, mode: u32) -> Result<Self::Temp, IoError>;
    async fn write_all(&self, temporary: &mut Self::Temp, bytes: &[u8]) -> Result<(), IoError>;
    async fn flush(&self, temporary: &mut Self::Temp) -> Result<(), IoError>;
    async fn set_mode(&self, temporary: &mut Self::Temp, mode: u32) -> Result<(), IoError>;
    async fn sync(&self, temporary: &mut Self::Temp) -> Result<(), IoError>;
    async fn close(&self, temporary: Self::Temp) -> Result<(), IoError>;
    async fn acquire_replace_lock(&self, target: &str) -> Result<(), IoError>;
    async fn release_replace_lock(&self, target: &str) -> Result<(), IoError>;
    async fn atomic_replace(&self, temporary: &str, target: &str) -> Result<(), ReplaceError>;
    async fn remove_temp(&self, path: &str) -> Result<(), IoError>;
}

pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn regular(file: RemoteFile) -> Result<RemoteFile, IoError> {
    if file.kind != RemoteFileKind::Regular {
        return Err(IoError("editable path must be a regular file".into()));
    }
    Ok(file)
}

async fn cleanup<IO: RemoteWriteIo>(io: &IO, path: &str) -> bool {
    io.remove_temp(path).await.is_err()
}

fn error(stage: TransactionStage, source: IoError, cleanup_pending: bool) -> TransactionError {
    TransactionError {
        stage,
        source: source.0,
        cleanup_pending,
    }
}

async fn reconcile<IO: RemoteWriteIo>(
    io: &IO,
    request: &WriteRequest<'_>,
    original_fingerprint: &str,
    mode: u32,
    stage: TransactionStage,
) -> Result<TransactionOutcome, TransactionError> {
    let attempted = fingerprint(request.content);
    match io.read_regular(request.target).await.and_then(regular) {
        Ok(observed) if observed.bytes == request.content && observed.mode == mode => {
            Ok(TransactionOutcome::Saved {
                fingerprint: attempted,
                size: observed.bytes.len() as u64,
            })
        }
        Ok(observed) => {
            let current = fingerprint(&observed.bytes);
            let cleanup_pending = cleanup(io, request.temporary).await;
            if current == original_fingerprint {
                Err(TransactionError {
                    stage,
                    source: "atomic replace did not take effect".into(),
                    cleanup_pending,
                })
            } else {
                Ok(TransactionOutcome::Conflict {
                    current_fingerprint: current,
                    cleanup_pending,
                })
            }
        }
        Err(_) => {
            let cleanup_pending = cleanup(io, request.temporary).await;
            Ok(TransactionOutcome::OutcomeUnknown {
                attempted_fingerprint: attempted,
                expected_mode: mode,
                cleanup_pending,
            })
        }
    }
}

pub(crate) async fn write_text_transaction<IO: RemoteWriteIo>(
    io: &IO,
    path_lock: &Mutex<()>,
    request: WriteRequest<'_>,
) -> Result<TransactionOutcome, TransactionError> {
    let _guard = path_lock.lock().await;
    let original = io
        .read_regular(request.target)
        .await
        .and_then(regular)
        .map_err(|source| error(TransactionStage::InitialRead, source, false))?;
    let original_fingerprint = fingerprint(&original.bytes);
    if original_fingerprint != request.expected_fingerprint {
        return Ok(TransactionOutcome::Conflict {
            current_fingerprint: original_fingerprint,
            cleanup_pending: false,
        });
    }

    let mut temporary = io
        .create_exclusive(request.temporary, original.mode)
        .await
        .map_err(|source| error(TransactionStage::Create, source, false))?;

    macro_rules! prepare {
        ($operation:expr, $stage:expr) => {
            if let Err(source) = $operation.await {
                let cleanup_pending = cleanup(io, request.temporary).await;
                return Err(error($stage, source, cleanup_pending));
            }
        };
    }
    prepare!(
        io.write_all(&mut temporary, request.content),
        TransactionStage::Write
    );
    prepare!(io.flush(&mut temporary), TransactionStage::Flush);
    prepare!(
        io.set_mode(&mut temporary, original.mode),
        TransactionStage::SetMode
    );
    prepare!(io.sync(&mut temporary), TransactionStage::Sync);
    if let Err(source) = io.close(temporary).await {
        let cleanup_pending = cleanup(io, request.temporary).await;
        return Err(error(TransactionStage::Close, source, cleanup_pending));
    }

    if let Err(source) = io.acquire_replace_lock(request.target).await {
        let cleanup_pending = cleanup(io, request.temporary).await;
        return Err(error(
            TransactionStage::AcquireReplaceLock,
            source,
            cleanup_pending,
        ));
    }

    let result = replace_while_locked(io, &request, &original_fingerprint, original.mode).await;
    match io.release_replace_lock(request.target).await {
        Ok(()) => result,
        Err(release_error) => match result {
            Ok(TransactionOutcome::Saved { .. }) => Ok(TransactionOutcome::OutcomeUnknown {
                attempted_fingerprint: fingerprint(request.content),
                expected_mode: original.mode,
                cleanup_pending: true,
            }),
            Ok(TransactionOutcome::Conflict {
                current_fingerprint,
                ..
            }) => Ok(TransactionOutcome::Conflict {
                current_fingerprint,
                cleanup_pending: true,
            }),
            Ok(TransactionOutcome::OutcomeUnknown {
                attempted_fingerprint,
                expected_mode,
                ..
            }) => Ok(TransactionOutcome::OutcomeUnknown {
                attempted_fingerprint,
                expected_mode,
                cleanup_pending: true,
            }),
            Err(mut transaction_error) => {
                transaction_error.stage = TransactionStage::ReleaseReplaceLock;
                transaction_error.source = format!(
                    "{}; release replace lock: {}",
                    transaction_error.source, release_error.0
                );
                transaction_error.cleanup_pending = true;
                Err(transaction_error)
            }
        },
    }
}

async fn replace_while_locked<IO: RemoteWriteIo>(
    io: &IO,
    request: &WriteRequest<'_>,
    original_fingerprint: &str,
    original_mode: u32,
) -> Result<TransactionOutcome, TransactionError> {
    let latest = match io.read_regular(request.target).await.and_then(regular) {
        Ok(file) => file,
        Err(source) => {
            let cleanup_pending = cleanup(io, request.temporary).await;
            return Err(error(
                TransactionStage::PreReplaceRead,
                source,
                cleanup_pending,
            ));
        }
    };
    let latest_fingerprint = fingerprint(&latest.bytes);
    if latest_fingerprint != request.expected_fingerprint {
        let cleanup_pending = cleanup(io, request.temporary).await;
        return Ok(TransactionOutcome::Conflict {
            current_fingerprint: latest_fingerprint,
            cleanup_pending,
        });
    }

    match io.atomic_replace(request.temporary, request.target).await {
        Ok(()) => {
            reconcile(
                io,
                request,
                original_fingerprint,
                original_mode,
                TransactionStage::Verify,
            )
            .await
        }
        Err(ReplaceError::StatusLost(_)) => {
            reconcile(
                io,
                request,
                original_fingerprint,
                original_mode,
                TransactionStage::Replace,
            )
            .await
        }
        Err(ReplaceError::NotSent(source)) | Err(ReplaceError::Unsupported(source)) => {
            let cleanup_pending = cleanup(io, request.temporary).await;
            Err(TransactionError {
                stage: TransactionStage::Replace,
                source,
                cleanup_pending,
            })
        }
    }
}

#[cfg(test)]
mod tests;
