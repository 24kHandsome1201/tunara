//! Cross-transport terminal output flow control.
//!
//! Tauri channels are non-blocking, so a fast PTY/SSH producer can otherwise
//! enqueue hundreds of MiB before xterm has parsed the first frames. This
//! window is replenished only after xterm's write callback acknowledges bytes.

use std::sync::Arc;

use parking_lot::{Condvar, Mutex};
use tokio::sync::Notify;

pub(super) const OUTPUT_WINDOW_BYTES: usize = 2 * 1024 * 1024;

struct OutputFlowState {
    available: usize,
    closed: bool,
}

pub(crate) struct OutputFlow {
    state: Mutex<OutputFlowState>,
    blocking_ready: Condvar,
    async_ready: Notify,
}

impl OutputFlow {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(OutputFlowState {
                available: OUTPUT_WINDOW_BYTES,
                closed: false,
            }),
            blocking_ready: Condvar::new(),
            async_ready: Notify::new(),
        })
    }

    pub(crate) fn reserve_blocking(&self, bytes: usize) -> bool {
        if bytes > OUTPUT_WINDOW_BYTES {
            return false;
        }
        let mut state = self.state.lock();
        while !state.closed && state.available < bytes {
            self.blocking_ready.wait(&mut state);
        }
        if state.closed {
            return false;
        }
        state.available -= bytes;
        true
    }

    pub(crate) async fn reserve(&self, bytes: usize) -> bool {
        if bytes > OUTPUT_WINDOW_BYTES {
            return false;
        }
        loop {
            let notified = self.async_ready.notified();
            {
                let mut state = self.state.lock();
                if state.closed {
                    return false;
                }
                if state.available >= bytes {
                    state.available -= bytes;
                    return true;
                }
            }
            notified.await;
        }
    }

    pub(crate) fn acknowledge(&self, bytes: usize) {
        if bytes == 0 {
            return;
        }
        {
            let mut state = self.state.lock();
            if state.closed {
                return;
            }
            state.available = state
                .available
                .saturating_add(bytes)
                .min(OUTPUT_WINDOW_BYTES);
        }
        self.blocking_ready.notify_all();
        self.async_ready.notify_waiters();
    }

    pub(crate) fn close(&self) {
        {
            let mut state = self.state.lock();
            state.closed = true;
        }
        self.blocking_ready.notify_all();
        self.async_ready.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn blocking_producer_waits_until_the_frontend_acknowledges_bytes() {
        let flow = OutputFlow::new();
        assert!(flow.reserve_blocking(OUTPUT_WINDOW_BYTES));
        let waiting = flow.clone();
        let (tx, rx) = mpsc::channel();
        let thread = thread::spawn(move || {
            tx.send(waiting.reserve_blocking(1)).expect("send result");
        });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.acknowledge(1);
        assert!(rx
            .recv_timeout(Duration::from_secs(1))
            .expect("producer resumes"));
        thread.join().expect("producer thread");
    }

    #[tokio::test]
    async fn close_releases_an_async_producer_waiting_for_credit() {
        let flow = OutputFlow::new();
        assert!(flow.reserve(OUTPUT_WINDOW_BYTES).await);
        let waiting = flow.clone();
        let waiter = tokio::spawn(async move { waiting.reserve(1).await });
        tokio::task::yield_now().await;
        flow.close();
        assert!(!waiter.await.expect("waiter task"));
    }

    #[test]
    fn duplicate_acknowledgements_never_expand_the_window() {
        let flow = OutputFlow::new();
        flow.acknowledge(OUTPUT_WINDOW_BYTES);
        assert!(flow.reserve_blocking(OUTPUT_WINDOW_BYTES));
        let waiting = flow.clone();
        let (tx, rx) = mpsc::channel();
        let thread = thread::spawn(move || {
            tx.send(waiting.reserve_blocking(1)).ok();
        });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.close();
        thread.join().expect("producer thread");
    }
}
