//! Bounded control planes for an interactive SSH channel.
//!
//! Data, Resize, and Close deliberately do not share one FIFO: byte-heavy
//! input cannot delay cancellation, and resize storms retain only the latest
//! dimensions. Remote output is coalesced behind a strict time/byte bound by
//! the connection pump.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{watch, Notify};

pub(super) const INPUT_BYTE_BUDGET: usize = 256 * 1024;
pub(super) const INPUT_MESSAGE_CAP: usize = 1024;
pub(super) const INPUT_WRITE_CHUNK_BYTES: usize = 32 * 1024;
pub(super) const OUTPUT_BATCH_MAX_BYTES: usize = 128 * 1024;
pub(super) const OUTPUT_BATCH_INTERVAL: Duration = Duration::from_millis(8);

struct InputQueueState {
    queue: VecDeque<Vec<u8>>,
    /// Includes the batch already dequeued by the pump but still waiting on
    /// SSH flow control. `ReservedInput::drop` releases that final reservation.
    reserved_bytes: usize,
    closed: bool,
}

pub(super) struct SshControl {
    input: Mutex<InputQueueState>,
    input_ready: Notify,
    close_requested: AtomicBool,
    close_ready: Notify,
    resize_tx: watch::Sender<Option<(u16, u16)>>,
}

pub(super) struct ReservedInput {
    pub(super) bytes: Vec<u8>,
    control: Arc<SshControl>,
}

impl Drop for ReservedInput {
    fn drop(&mut self) {
        self.control.release_input(self.bytes.len());
    }
}

impl SshControl {
    pub(super) fn new() -> (Arc<Self>, watch::Receiver<Option<(u16, u16)>>) {
        let (resize_tx, resize_rx) = watch::channel(None);
        let control = Arc::new(Self {
            input: Mutex::new(InputQueueState {
                queue: VecDeque::new(),
                reserved_bytes: 0,
                closed: false,
            }),
            input_ready: Notify::new(),
            close_requested: AtomicBool::new(false),
            close_ready: Notify::new(),
            resize_tx,
        });
        (control, resize_rx)
    }

    pub(super) fn try_enqueue(&self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        let mut state = self
            .input
            .lock()
            .map_err(|_| "ssh session closed".to_string())?;
        if state.closed || self.close_requested.load(Ordering::Acquire) {
            return Err("ssh session closed".into());
        }
        let Some(next_bytes) = state.reserved_bytes.checked_add(data.len()) else {
            return Err("ssh input queue full".into());
        };
        if next_bytes > INPUT_BYTE_BUDGET || state.queue.len() >= INPUT_MESSAGE_CAP {
            return Err("ssh input queue full".into());
        }
        state.queue.push_back(data.to_vec());
        state.reserved_bytes = next_bytes;
        drop(state);
        self.input_ready.notify_one();
        Ok(())
    }

    pub(super) async fn next_input(self: &Arc<Self>) -> Option<ReservedInput> {
        loop {
            let notified = self.input_ready.notified();
            {
                let mut state = self.input.lock().ok()?;
                if let Some(bytes) = state.queue.pop_front() {
                    return Some(ReservedInput {
                        bytes,
                        control: self.clone(),
                    });
                }
                if state.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    fn release_input(&self, bytes: usize) {
        if let Ok(mut state) = self.input.lock() {
            state.reserved_bytes = state.reserved_bytes.saturating_sub(bytes);
        }
    }

    pub(super) fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if self.close_requested.load(Ordering::Acquire) {
            return Err("ssh session closed".into());
        }
        self.resize_tx
            .send(Some((cols, rows)))
            .map_err(|_| "ssh session closed".to_string())
    }

    pub(super) fn request_close(&self) {
        self.close_requested.store(true, Ordering::Release);
        if let Ok(mut state) = self.input.lock() {
            let queued_bytes = state.queue.iter().map(Vec::len).sum::<usize>();
            state.queue.clear();
            state.reserved_bytes = state.reserved_bytes.saturating_sub(queued_bytes);
            state.closed = true;
        }
        self.input_ready.notify_waiters();
        self.close_ready.notify_waiters();
    }

    pub(super) async fn wait_for_close(&self) {
        while !self.close_requested.load(Ordering::Acquire) {
            self.close_ready.notified().await;
        }
    }
}

pub(super) struct SshOutputBatch {
    pending: Vec<u8>,
}

impl SshOutputBatch {
    pub(super) fn new() -> Self {
        Self {
            pending: Vec::with_capacity(OUTPUT_BATCH_MAX_BYTES),
        }
    }

    pub(super) fn push(&mut self, mut data: &[u8]) -> Vec<Vec<u8>> {
        let mut ready = Vec::new();
        while !data.is_empty() {
            let room = OUTPUT_BATCH_MAX_BYTES - self.pending.len();
            let take = room.min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.pending.len() == OUTPUT_BATCH_MAX_BYTES {
                ready.push(std::mem::replace(
                    &mut self.pending,
                    Vec::with_capacity(OUTPUT_BATCH_MAX_BYTES),
                ));
            }
        }
        ready
    }

    pub(super) fn flush(&mut self) -> Option<Vec<u8>> {
        if self.pending.is_empty() {
            None
        } else {
            Some(std::mem::replace(
                &mut self.pending,
                Vec::with_capacity(OUTPUT_BATCH_MAX_BYTES),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn input_budget_counts_the_in_flight_batch_until_send_finishes() {
        let (control, _resize_rx) = SshControl::new();
        let full = vec![b'x'; INPUT_BYTE_BUDGET];
        control
            .try_enqueue(&full)
            .expect("budget-sized paste accepted");
        assert_eq!(
            control.try_enqueue(b"y").unwrap_err(),
            "ssh input queue full"
        );

        let in_flight = control.next_input().await.expect("queued input");
        assert_eq!(in_flight.bytes.len(), INPUT_BYTE_BUDGET);
        assert_eq!(
            control.try_enqueue(b"y").unwrap_err(),
            "ssh input queue full",
            "popping must not release bytes before network send finishes"
        );
        drop(in_flight);
        control.try_enqueue(b"y").expect("drop releases budget");
    }

    #[test]
    fn input_queue_also_bounds_tiny_message_overhead() {
        let (control, _resize_rx) = SshControl::new();
        for _ in 0..INPUT_MESSAGE_CAP {
            control.try_enqueue(b"x").expect("within message cap");
        }
        assert_eq!(
            control.try_enqueue(b"x").unwrap_err(),
            "ssh input queue full"
        );
    }

    #[tokio::test]
    async fn close_is_idempotent_and_bypasses_a_full_input_queue() {
        let (control, _resize_rx) = SshControl::new();
        control
            .try_enqueue(&vec![b'x'; INPUT_BYTE_BUDGET])
            .expect("fill byte budget");
        control.request_close();
        control.request_close();

        tokio::time::timeout(Duration::from_millis(50), control.wait_for_close())
            .await
            .expect("close signal is not queued behind data");
        assert!(control.next_input().await.is_none());
        assert_eq!(
            control.try_enqueue(b"late").unwrap_err(),
            "ssh session closed"
        );
        assert_eq!(control.resize(80, 24).unwrap_err(), "ssh session closed");
    }

    #[tokio::test]
    async fn resize_channel_retains_only_the_latest_dimensions() {
        let (control, mut resize_rx) = SshControl::new();
        control.resize(80, 24).expect("first resize");
        control.resize(132, 43).expect("latest resize");
        resize_rx.changed().await.expect("resize receiver alive");
        assert_eq!(*resize_rx.borrow_and_update(), Some((132, 43)));
    }

    #[test]
    fn output_batch_splits_at_the_byte_cap_without_reordering() {
        let mut batch = SshOutputBatch::new();
        let first = vec![b'a'; OUTPUT_BATCH_MAX_BYTES - 2];
        let second = b"bcde";
        assert!(batch.push(&first).is_empty());
        let ready = batch.push(second);
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].len(), OUTPUT_BATCH_MAX_BYTES);
        assert_eq!(&ready[0][..first.len()], first.as_slice());
        assert_eq!(&ready[0][first.len()..], b"bc");
        assert_eq!(batch.flush().as_deref(), Some(b"de".as_slice()));
        assert!(batch.flush().is_none());
    }
}
