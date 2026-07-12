use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailAt {
    InitialRead,
    Create,
    Write,
    Flush,
    SetMode,
    Sync,
    Close,
    AcquireLock,
    ReleaseLock,
    PreRead,
    ReplaceNotSent,
    Unsupported,
    LostBefore,
    LostAfter,
    ReconcileDisconnect,
    Cleanup,
    SameSizeSwap,
    SymlinkSwap,
    VerifyWrongMode,
}

#[derive(Clone)]
struct FakeIo {
    state: Arc<StdMutex<State>>,
    fail: Option<FailAt>,
    reads: Arc<AtomicUsize>,
}

struct State {
    target: RemoteFile,
    temps: HashMap<String, RemoteFile>,
    removed: usize,
}
#[derive(Default)]
struct Temp {
    path: String,
    bytes: Vec<u8>,
    mode: u32,
}

impl FakeIo {
    fn new(bytes: &[u8], mode: u32, fail: Option<FailAt>) -> Self {
        Self {
            state: Arc::new(StdMutex::new(State {
                target: RemoteFile {
                    bytes: bytes.to_vec(),
                    mode,
                    kind: RemoteFileKind::Regular,
                },
                temps: HashMap::new(),
                removed: 0,
            })),
            fail,
            reads: Arc::new(AtomicUsize::new(0)),
        }
    }
    fn snapshot(&self) -> (RemoteFile, usize, usize) {
        let s = self.state.lock().unwrap();
        (s.target.clone(), s.temps.len(), s.removed)
    }
}

impl RemoteWriteIo for FakeIo {
    type Temp = Temp;
    async fn read_regular(&self, _path: &str) -> Result<RemoteFile, IoError> {
        let read = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail == Some(FailAt::InitialRead) && read == 1 {
            return Err(IoError("initial-read".into()));
        }
        if self.fail == Some(FailAt::PreRead) && read == 2 {
            return Err(IoError("pre-read".into()));
        }
        if self.fail == Some(FailAt::SameSizeSwap) && read == 2 {
            self.state.lock().unwrap().target.bytes = b"BBBB".to_vec();
        }
        if self.fail == Some(FailAt::SymlinkSwap) && read == 2 {
            self.state.lock().unwrap().target.kind = RemoteFileKind::Symlink;
        }
        if self.fail == Some(FailAt::ReconcileDisconnect) && read >= 3 {
            return Err(IoError("disconnected".into()));
        }
        if self.fail == Some(FailAt::VerifyWrongMode) && read >= 3 {
            self.state.lock().unwrap().target.mode = 0o600;
        }
        Ok(self.state.lock().unwrap().target.clone())
    }
    async fn create_exclusive(&self, path: &str, mode: u32) -> Result<Temp, IoError> {
        if self.fail == Some(FailAt::Create) {
            return Err(IoError("create".into()));
        }
        self.state.lock().unwrap().temps.insert(
            path.into(),
            RemoteFile {
                bytes: Vec::new(),
                mode,
                kind: RemoteFileKind::Regular,
            },
        );
        Ok(Temp {
            path: path.into(),
            mode,
            ..Default::default()
        })
    }
    async fn write_all(&self, t: &mut Temp, b: &[u8]) -> Result<(), IoError> {
        tokio::task::yield_now().await;
        if matches!(self.fail, Some(FailAt::Write | FailAt::Cleanup)) {
            return Err(IoError("write".into()));
        }
        t.bytes.extend_from_slice(b);
        Ok(())
    }
    async fn flush(&self, _: &mut Temp) -> Result<(), IoError> {
        if self.fail == Some(FailAt::Flush) {
            Err(IoError("flush".into()))
        } else {
            Ok(())
        }
    }
    async fn set_mode(&self, t: &mut Temp, m: u32) -> Result<(), IoError> {
        if self.fail == Some(FailAt::SetMode) {
            Err(IoError("mode".into()))
        } else {
            t.mode = m;
            Ok(())
        }
    }
    async fn sync(&self, _: &mut Temp) -> Result<(), IoError> {
        if self.fail == Some(FailAt::Sync) {
            Err(IoError("sync".into()))
        } else {
            Ok(())
        }
    }
    async fn close(&self, t: Temp) -> Result<(), IoError> {
        if self.fail == Some(FailAt::Close) {
            return Err(IoError("close".into()));
        }
        self.state.lock().unwrap().temps.insert(
            t.path,
            RemoteFile {
                bytes: t.bytes,
                mode: t.mode,
                kind: RemoteFileKind::Regular,
            },
        );
        Ok(())
    }
    async fn acquire_replace_lock(&self, _: &str) -> Result<(), IoError> {
        if self.fail == Some(FailAt::AcquireLock) {
            Err(IoError("acquire-lock".into()))
        } else {
            Ok(())
        }
    }
    async fn release_replace_lock(&self, _: &str) -> Result<(), IoError> {
        if self.fail == Some(FailAt::ReleaseLock) {
            Err(IoError("release-lock".into()))
        } else {
            Ok(())
        }
    }
    async fn atomic_replace(&self, temp: &str, _: &str) -> Result<(), ReplaceError> {
        match self.fail {
            Some(FailAt::ReplaceNotSent) => return Err(ReplaceError::NotSent("not sent".into())),
            Some(FailAt::Unsupported) => {
                return Err(ReplaceError::Unsupported("unsupported".into()))
            }
            Some(FailAt::LostBefore) | Some(FailAt::ReconcileDisconnect) => {
                return Err(ReplaceError::StatusLost("lost".into()))
            }
            _ => {}
        }
        let file = self.state.lock().unwrap().temps.remove(temp).unwrap();
        self.state.lock().unwrap().target = file;
        if self.fail == Some(FailAt::LostAfter) {
            Err(ReplaceError::StatusLost("lost".into()))
        } else {
            Ok(())
        }
    }
    async fn remove_temp(&self, path: &str) -> Result<(), IoError> {
        if matches!(
            self.fail,
            Some(FailAt::Cleanup | FailAt::ReconcileDisconnect)
        ) {
            return Err(IoError("cleanup".into()));
        }
        let mut s = self.state.lock().unwrap();
        s.temps.remove(path);
        s.removed += 1;
        Ok(())
    }
}

fn request<'a>(content: &'a [u8], expected: &'a str) -> WriteRequest<'a> {
    WriteRequest {
        target: "/tmp/file",
        temporary: "/tmp/.file.tunara.tmp",
        content,
        expected_fingerprint: expected,
    }
}

#[tokio::test]
async fn preparation_failures_preserve_target_and_cleanup() {
    for (fail, expected_stage) in [
        (FailAt::Write, TransactionStage::Write),
        (FailAt::Flush, TransactionStage::Flush),
        (FailAt::SetMode, TransactionStage::SetMode),
        (FailAt::Sync, TransactionStage::Sync),
        (FailAt::Close, TransactionStage::Close),
        (FailAt::PreRead, TransactionStage::PreReplaceRead),
        (FailAt::ReplaceNotSent, TransactionStage::Replace),
        (FailAt::Unsupported, TransactionStage::Replace),
    ] {
        let io = FakeIo::new(b"before", 0o640, Some(fail));
        let error = write_text_transaction(
            &io,
            &Mutex::new(()),
            request(b"after", &fingerprint(b"before")),
        )
        .await
        .unwrap_err();
        assert_eq!(error.stage, expected_stage, "{fail:?}");
        assert!(!error.cleanup_pending, "{fail:?}");
        let (s, temps, removed) = io.snapshot();
        assert_eq!(s.bytes, b"before");
        assert_eq!(s.mode, 0o640);
        assert_eq!(temps, 0, "{fail:?}");
        assert_eq!(removed, 1, "{fail:?}");
    }
}

#[tokio::test]
async fn initial_read_failure_never_allocates_or_cleans_temp() {
    let io = FakeIo::new(b"before", 0o640, Some(FailAt::InitialRead));
    let error = write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap_err();
    assert_eq!(error.stage, TransactionStage::InitialRead);
    let (target, temps, removed) = io.snapshot();
    assert_eq!(target.bytes, b"before");
    assert_eq!(temps, 0);
    assert_eq!(removed, 0);
}

#[tokio::test]
async fn create_failure_never_allocates_or_cleans_temp() {
    let io = FakeIo::new(b"before", 0o640, Some(FailAt::Create));
    let _ = write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap_err();
    let (s, temps, removed) = io.snapshot();
    assert_eq!(s.bytes, b"before");
    assert_eq!(temps, 0);
    assert_eq!(removed, 0);
}

#[tokio::test]
async fn replace_lock_failures_never_invite_a_blind_retry() {
    let acquire = FakeIo::new(b"before", 0o640, Some(FailAt::AcquireLock));
    let error = write_text_transaction(
        &acquire,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap_err();
    assert_eq!(error.stage, TransactionStage::AcquireReplaceLock);
    let (target, temps, removed) = acquire.snapshot();
    assert_eq!(target.bytes, b"before");
    assert_eq!(temps, 0);
    assert_eq!(removed, 1);

    let release = FakeIo::new(b"before", 0o640, Some(FailAt::ReleaseLock));
    let outcome = write_text_transaction(
        &release,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap();
    assert!(matches!(
        outcome,
        TransactionOutcome::OutcomeUnknown {
            expected_mode: 0o640,
            cleanup_pending: true,
            ..
        }
    ));
    assert_eq!(release.snapshot().0.bytes, b"after");
}

#[tokio::test]
async fn status_lost_before_and_after_are_reconciled() {
    for (fail, saved) in [(FailAt::LostBefore, false), (FailAt::LostAfter, true)] {
        let io = FakeIo::new(b"before", 0o640, Some(fail));
        let result = write_text_transaction(
            &io,
            &Mutex::new(()),
            request(b"after", &fingerprint(b"before")),
        )
        .await;
        if saved {
            assert!(matches!(result, Ok(TransactionOutcome::Saved { .. })));
        } else {
            let error = result.unwrap_err();
            assert_eq!(error.stage, TransactionStage::Replace);
            assert!(!error.cleanup_pending);
        }
        let (s, temps, removed) = io.snapshot();
        assert_eq!(
            s.bytes,
            if saved {
                b"after".as_slice()
            } else {
                b"before".as_slice()
            }
        );
        assert_eq!(temps, 0);
        assert_eq!(removed, if saved { 0 } else { 1 });
    }
}

#[tokio::test]
async fn reconciliation_disconnect_is_outcome_unknown() {
    let io = FakeIo::new(b"before", 0o640, Some(FailAt::ReconcileDisconnect));
    let result = write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap();
    assert!(matches!(
        &result,
        TransactionOutcome::OutcomeUnknown {
            expected_mode: 0o640,
            cleanup_pending: true,
            ..
        }
    ));
    assert_eq!(io.snapshot().0.bytes, b"before");
}

#[tokio::test]
async fn cleanup_failure_is_reported_without_damaging_target() {
    let io = FakeIo::new(b"before", 0o640, Some(FailAt::Cleanup));
    let error = write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap_err();
    assert!(error.cleanup_pending);
    let (target, temps, removed) = io.snapshot();
    assert_eq!(target.bytes, b"before");
    assert_eq!(temps, 1);
    assert_eq!(removed, 0);
}

#[tokio::test]
async fn same_size_external_change_and_symlink_swap_conflict_or_fail() {
    let io = FakeIo::new(b"AAAA", 0o640, Some(FailAt::SameSizeSwap));
    let r = write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"CCCC", &fingerprint(b"AAAA")),
    )
    .await
    .unwrap();
    assert!(matches!(
        r,
        TransactionOutcome::Conflict {
            cleanup_pending: false,
            ..
        }
    ));
    let (target, temps, removed) = io.snapshot();
    assert_eq!(target.bytes, b"BBBB");
    assert_eq!(temps, 0);
    assert_eq!(removed, 1);
    let io = FakeIo::new(b"AAAA", 0o640, Some(FailAt::SymlinkSwap));
    assert!(write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"CCCC", &fingerprint(b"AAAA"))
    )
    .await
    .is_err());
    let (target, temps, removed) = io.snapshot();
    assert_eq!(target.bytes, b"AAAA");
    assert_eq!(temps, 0);
    assert_eq!(removed, 1);
}

#[tokio::test]
async fn verify_requires_both_attempted_bytes_and_original_mode() {
    let io = FakeIo::new(b"before", 0o640, Some(FailAt::VerifyWrongMode));
    let result = write_text_transaction(
        &io,
        &Mutex::new(()),
        request(b"after", &fingerprint(b"before")),
    )
    .await
    .unwrap();
    assert!(matches!(result, TransactionOutcome::Conflict { .. }));
    let target = io.snapshot().0;
    assert_eq!(target.bytes, b"after");
    assert_eq!(target.mode, 0o600);
}

#[tokio::test]
async fn same_path_transactions_are_serialized() {
    let io = FakeIo::new(b"before", 0o640, None);
    let lock = Mutex::new(());
    let expected = fingerprint(b"before");
    let first = write_text_transaction(&io, &lock, request(b"first", &expected));
    let second = write_text_transaction(&io, &lock, request(b"second", &expected));
    let (a, b) = tokio::join!(first, second);
    assert!(
        matches!(a, Ok(TransactionOutcome::Saved { .. }))
            || matches!(b, Ok(TransactionOutcome::Saved { .. }))
    );
    assert!(
        matches!(a, Ok(TransactionOutcome::Conflict { .. }))
            || matches!(b, Ok(TransactionOutcome::Conflict { .. }))
    );
}
