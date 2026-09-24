//! Bounded control planes for an interactive SSH channel.
//!
//! Data, Resize, and Close deliberately do not share one FIFO: byte-heavy
//! input cannot delay cancellation, and resize storms retain only the latest
//! dimensions. Remote output is coalesced behind a strict time/byte bound by
//! the connection pump.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

    pub(super) fn is_closed(&self) -> bool {
        self.close_requested.load(Ordering::Acquire)
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

/// How long the filter may hold back the trailing partial line (normally the
/// first prompt) while waiting for the bootstrap echo. Past this the shell is
/// evidently not reading the bootstrap yet (slow rc files, an rc prompt), so
/// its output must not stay invisible; echo stripping itself continues.
pub(super) const BOOTSTRAP_PROMPT_HOLD: Duration = Duration::from_millis(1500);
/// Upper bound on control bytes tolerated between two echoed characters, so a
/// stray partial match cannot hold output back indefinitely.
const ECHO_NOISE_MAX: usize = 512;

/// Removes Tunara's own bootstrap input from the initial interactive-shell
/// output. A tty may echo input once when it arrives and again when readline
/// redraws the pending canonical buffer, so suppression continues until the
/// bootstrap command emits its private completion marker. Both patterns may span
/// arbitrary SSH data frames.
///
/// Readline wraps a redraw that does not fit the pane (a freshly split pane may
/// start only a few columns wide) with `\r\n\r`, cursor moves and forced-wrap
/// spaces between the echoed characters, so echoes are matched while skipping
/// terminal control noise. The prompt line that carried the final echo, and
/// the Enter newline after it, are dropped together with the echo: the shell
/// draws a fresh prompt once the bootstrap finishes, so keeping the first one
/// would leave an empty prompt line above it. A standalone early echo line
/// (input typed before the shell took over the tty) is dropped whole too.
pub(super) struct SshBootstrapOutputFilter {
    typed_command: Vec<u8>,
    completion_marker: Vec<u8>,
    pending: Vec<u8>,
    complete: bool,
    hold_prompt: bool,
    created_at: Instant,
}

enum EchoSearch {
    Full { start: usize, end: usize },
    Partial { start: usize },
    None,
}

impl SshBootstrapOutputFilter {
    pub(super) fn new(typed_line: &[u8], completion_marker: &[u8]) -> Self {
        let start = typed_line
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .unwrap_or(typed_line.len());
        let end = typed_line
            .iter()
            .rposition(|byte| !byte.is_ascii_whitespace())
            .map(|index| index + 1)
            .unwrap_or(start);
        let typed_command = typed_line[start..end].to_vec();
        Self {
            complete: typed_command.is_empty() || completion_marker.is_empty(),
            typed_command,
            completion_marker: completion_marker.to_vec(),
            pending: Vec::new(),
            hold_prompt: true,
            created_at: Instant::now(),
        }
    }

    pub(super) fn push(&mut self, data: &[u8]) -> Vec<u8> {
        if self.complete {
            return data.to_vec();
        }

        self.pending.extend_from_slice(data);
        if let Some(at) = find_bytes(&self.pending, &self.completion_marker) {
            let tail = self.pending.split_off(at + self.completion_marker.len());
            self.pending.truncate(at);
            let mut visible = self.strip_echoes(true);
            visible.extend_from_slice(&tail);
            self.complete = true;
            return visible;
        }
        self.strip_echoes(false)
    }

    /// Stop holding the trailing partial line once `BOOTSTRAP_PROMPT_HOLD`
    /// has elapsed, returning whatever becomes visible.
    pub(super) fn expire_prompt_hold(&mut self, now: Instant) -> Vec<u8> {
        if self.complete
            || !self.hold_prompt
            || now.saturating_duration_since(self.created_at) < BOOTSTRAP_PROMPT_HOLD
        {
            return Vec::new();
        }
        self.hold_prompt = false;
        self.strip_echoes(false)
    }

    pub(super) fn is_complete(&self) -> bool {
        self.complete
    }

    pub(super) fn finish(mut self) -> Vec<u8> {
        self.hold_prompt = false;
        let mut visible = self.strip_echoes(false);
        visible.append(&mut self.pending);
        visible
    }

    /// Emits the resolved prefix of `pending`, dropping complete echoes, and
    /// keeps only what may still belong to an echo or to the final echo's
    /// prompt line. With `completed`, `pending` ends at the completion marker
    /// and is consumed entirely.
    fn strip_echoes(&mut self, completed: bool) -> Vec<u8> {
        let mut visible = Vec::new();
        let mut cursor = 0;
        let keep_from = loop {
            let (start, end) = match find_echo(&self.pending[cursor..], &self.typed_command) {
                EchoSearch::Full { start, end } => (cursor + start, cursor + end),
                EchoSearch::Partial { start } => break self.hold_start(cursor, cursor + start),
                EchoSearch::None if completed || !self.hold_prompt => {
                    let keep = if completed {
                        0
                    } else {
                        suffix_prefix_len(&self.pending[cursor..], &self.completion_marker)
                    };
                    break self.pending.len() - keep;
                }
                EchoSearch::None => break line_start(&self.pending, cursor, self.pending.len()),
            };
            let line = line_start(&self.pending, cursor, start);
            let after = &self.pending[end..];
            let followed_by_echo = matches!(
                find_echo(after, &self.typed_command),
                EchoSearch::Full { .. }
            );
            if !followed_by_echo && line_breaks(after) <= 1 {
                if completed {
                    // The final echo: its prompt, any redraw fix-ups and the
                    // Enter newline all precede the completion marker.
                    visible.extend_from_slice(&self.pending[cursor..line]);
                    cursor = self.pending.len();
                    break cursor;
                }
                // Not yet known whether more output follows this echo.
                break self.hold_start(cursor, start);
            }
            // An earlier echo: drop it, and its whole line when nothing else
            // was printed on it.
            let blank_line = self.pending[line..start]
                .iter()
                .all(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control());
            let newline = if after.starts_with(b"\r\n") {
                2
            } else {
                usize::from(after.starts_with(b"\n"))
            };
            if blank_line && newline > 0 {
                visible.extend_from_slice(&self.pending[cursor..line]);
                cursor = end + newline;
            } else {
                visible.extend_from_slice(&self.pending[cursor..start]);
                cursor = end;
            }
        };
        let emit_to = keep_from.max(cursor);
        visible.extend_from_slice(&self.pending[cursor..emit_to]);
        self.pending.drain(..emit_to);
        visible
    }

    fn hold_start(&self, cursor: usize, echo_start: usize) -> usize {
        if self.hold_prompt {
            line_start(&self.pending, cursor, echo_start)
        } else {
            echo_start
        }
    }
}

/// Finds the first occurrence of `command` echoed with terminal control noise
/// (C0 controls, escape sequences, forced-wrap spaces) between its characters,
/// or else the earliest match cut short by the end of `data`.
fn find_echo(data: &[u8], command: &[u8]) -> EchoSearch {
    let Some(&first) = command.first() else {
        return EchoSearch::None;
    };
    let mut partial = None;
    for start in 0..data.len() {
        if data[start] != first {
            continue;
        }
        match match_echo_at(data, start, command) {
            EchoMatch::Full(end) => return EchoSearch::Full { start, end },
            EchoMatch::Partial => {
                partial.get_or_insert(start);
            }
            EchoMatch::Fail => {}
        }
    }
    match partial {
        Some(start) => EchoSearch::Partial { start },
        None => EchoSearch::None,
    }
}

enum EchoMatch {
    Full(usize),
    Partial,
    Fail,
}

fn match_echo_at(data: &[u8], start: usize, command: &[u8]) -> EchoMatch {
    let mut at = start;
    let mut matched = 0;
    let mut noise = 0;
    while matched < command.len() {
        let Some(&byte) = data.get(at) else {
            return EchoMatch::Partial;
        };
        if byte == command[matched] {
            at += 1;
            matched += 1;
            noise = 0;
            continue;
        }
        match echo_noise_len(&data[at..]) {
            Some(0) => return EchoMatch::Fail,
            Some(len) => {
                at += len;
                noise += len;
            }
            None => return EchoMatch::Partial,
        }
        if noise > ECHO_NOISE_MAX {
            return EchoMatch::Fail;
        }
    }
    EchoMatch::Full(at)
}

/// Length of the terminal control noise at the start of `data`: `Some(0)` for
/// ordinary text, `None` when more bytes are needed to decide.
fn echo_noise_len(data: &[u8]) -> Option<usize> {
    match data {
        [] | [0x1b] | [b' '] => None,
        [0x1b, b'[', rest @ ..] => {
            let end = rest.iter().position(|byte| (0x40..=0x7e).contains(byte))?;
            Some(2 + end + 1)
        }
        [0x1b, _, ..] => Some(2),
        [byte, ..] if byte.is_ascii_control() => Some(1),
        [b' ', b'\r' | b'\x08', ..] => Some(1),
        _ => Some(0),
    }
}

/// Start of the visual line containing `at`. Readline continues a wrapped
/// line with `\n\r`, so only a newline followed by anything else starts a new
/// one; a trailing newline stays undecided until its next byte arrives.
fn line_start(data: &[u8], floor: usize, at: usize) -> usize {
    (floor..at)
        .rev()
        .find(|&index| is_line_break(data, index))
        .map(|index| index + 1)
        .unwrap_or(floor)
}

fn line_breaks(data: &[u8]) -> usize {
    (0..data.len())
        .filter(|&index| is_line_break(data, index))
        .count()
}

fn is_line_break(data: &[u8], index: usize) -> bool {
    data[index] == b'\n' && data.get(index + 1).is_some_and(|next| *next != b'\r')
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn suffix_prefix_len(data: &[u8], pattern: &[u8]) -> usize {
    let max = data.len().min(pattern.len().saturating_sub(1));
    (1..=max)
        .rev()
        .find(|&len| data[data.len() - len..] == pattern[..len])
        .unwrap_or(0)
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

    #[test]
    fn bootstrap_output_filter_strips_repeated_fragmented_echoes_until_completion() {
        let typed = b" . /tmp/.t-NvgmOd2pq5;rm -f /tmp/.t-NvgmOd2pq5\n";
        let completion = b"\x1b]777;tunara-bootstrap;session-1\x1b\\";
        let echoed = &typed[..typed.len() - 1];
        let mut raw = b"This system has been minimized\r\n".to_vec();
        raw.extend_from_slice(echoed);
        raw.extend_from_slice(b"\r\nshell startup output\r\nREMOTE> ");
        raw.extend_from_slice(echoed);
        raw.extend_from_slice(b"\r\n");
        raw.extend_from_slice(completion);
        raw.extend_from_slice(b"\x1b]7;file://localhost/srv/app\x1b\\REMOTE> ");

        for size in 1..=raw.len() {
            let visible = filter_in_chunks(typed, completion, &raw, size);
            // Neither the standalone early echo line nor the prompt line that
            // carried the final echo survives: only the shell's fresh prompt.
            assert_eq!(
                visible,
                b"This system has been minimized\r\nshell startup output\r\n\x1b]7;file://localhost/srv/app\x1b\\REMOTE> ",
                "chunk size {size}"
            );
            assert!(!visible
                .windows(completion.len())
                .any(|window| window == completion));
        }
    }

    const BOOTSTRAP_COMPLETION: &[u8] = b"\x1b]777;tunara-bootstrap;s1\x1b\\";
    const BASH_PROMPT: &[u8] =
        b"\x1b[?2004h\x1b]0;qauser@e2b: ~\x07\x1b[01;32mqauser@e2b\x1b[00m:\x1b[01;34m~\x1b[00m$ ";
    const RESTORED_PROMPT: &[u8] = b"\x1b[?2004h\x1b]0;qauser@e2b: ~/proj\x07\x1b[01;32mqauser@e2b\x1b[00m:\x1b[01;34m~/proj\x1b[00m$ ";

    fn filter_in_chunks(typed: &[u8], completion: &[u8], raw: &[u8], size: usize) -> Vec<u8> {
        let mut filter = SshBootstrapOutputFilter::new(typed, completion);
        let mut visible = Vec::new();
        for chunk in raw.chunks(size) {
            visible.extend(filter.push(chunk));
        }
        assert!(filter.is_complete());
        visible.extend(filter.finish());
        visible
    }

    fn assert_no_bootstrap_text(visible: &[u8]) {
        let text = String::from_utf8_lossy(visible);
        for leaked in ["/tmp/.t-", "rm -f", "tunara-bootstrap", "\\033"] {
            assert!(!text.contains(leaked), "{leaked:?} leaked into {text:?}");
        }
    }

    /// Captured from bash 5.2 over OpenSSH: a split pane that starts two
    /// columns wide makes readline wrap the prompt AND the echoed bootstrap
    /// with `\r\n\r`, then re-print the last character as a wrap fix-up.
    #[test]
    fn bootstrap_output_filter_strips_a_readline_wrapped_echo_in_a_narrow_pane() {
        let typed = b" . /tmp/.t-5tmkutksQI;rm -f /tmp/.t-5tmkutksQI\n";
        let mut raw = b"Last login: Thu Sep 24 22:10:36 2026 from 127.0.0.1\r\r\n".to_vec();
        raw.extend_from_slice(
            b"\x1b[?2004h\x1b]0;qauser@e2b: ~\x07\x1b[01;32mqauser@e2b\x1b[00m\r\n\r:\x1b[01;34m~\x1b[00m\r\n\r$  \r .\r\n\r /tmp/.t-5tmkutksQI;rm -f /tmp/.t-5tmkutksQI \r\x1b[C\x1b[KI\r\n\x1b[?2004l\r",
        );
        raw.extend_from_slice(BOOTSTRAP_COMPLETION);
        raw.extend_from_slice(RESTORED_PROMPT);

        let mut expected = b"Last login: Thu Sep 24 22:10:36 2026 from 127.0.0.1\r\r\n".to_vec();
        expected.extend_from_slice(RESTORED_PROMPT);
        for size in 1..=raw.len() {
            let visible = filter_in_chunks(typed, BOOTSTRAP_COMPLETION, &raw, size);
            assert_eq!(visible, expected, "chunk size {size}");
            assert_no_bootstrap_text(&visible);
        }
    }

    /// Captured: input typed before the shell starts is echoed by the tty
    /// ahead of the MOTD, then readline redraws it after a resize (SIGWINCH)
    /// with cursor-up / erase fix-ups trailing the echoed text.
    #[test]
    fn bootstrap_output_filter_strips_early_tty_echo_and_resize_redraw() {
        let typed = b" . /tmp/.t-UFWBsb9RTk;rm -f /tmp/.t-UFWBsb9RTk\n";
        let mut raw = b" . /tmp/.t-UFWBsb9RTk;rm -f /tmp/.t-UFWBsb9RTk\r\n".to_vec();
        raw.extend_from_slice(b"Linux e2b.local x86_64\r\n\r\nLast login: from 127.0.0.1\r\r\n");
        raw.extend_from_slice(BASH_PROMPT);
        raw.extend_from_slice(b"\r\x1b[K\r");
        raw.extend_from_slice(&BASH_PROMPT[b"\x1b[?2004h".len()..]);
        raw.extend_from_slice(b" . /tmp/.t-UFWBsb9RTk;rm -f /tmp/.t-UFWBsb9RTk \r\x1b[A\x1b[C\x1b[C\x1b[C\x1b[Kk\r\n\x1b[?2004l\r");
        raw.extend_from_slice(BOOTSTRAP_COMPLETION);
        raw.extend_from_slice(RESTORED_PROMPT);

        let mut expected =
            b"Linux e2b.local x86_64\r\n\r\nLast login: from 127.0.0.1\r\r\n".to_vec();
        expected.extend_from_slice(RESTORED_PROMPT);
        for size in 1..=raw.len() {
            let visible = filter_in_chunks(typed, BOOTSTRAP_COMPLETION, &raw, size);
            assert_eq!(visible, expected, "chunk size {size}");
            assert_no_bootstrap_text(&visible);
        }
    }

    #[test]
    fn bootstrap_output_filter_strips_the_direct_cwd_fallback_echo() {
        let typed = b" printf '\\033]777;tunara-bootstrap;s1\\033\\\\';cd '/srv/my app'\n";
        let mut raw = BASH_PROMPT.to_vec();
        raw.extend_from_slice(&typed[..typed.len() - 1]);
        raw.extend_from_slice(b"\r\n\x1b[?2004l\r");
        raw.extend_from_slice(BOOTSTRAP_COMPLETION);
        raw.extend_from_slice(RESTORED_PROMPT);

        for size in 1..=raw.len() {
            let visible = filter_in_chunks(typed, BOOTSTRAP_COMPLETION, &raw, size);
            assert_eq!(visible, RESTORED_PROMPT, "chunk size {size}");
        }
    }

    #[test]
    fn bootstrap_output_filter_releases_a_held_prompt_but_keeps_stripping() {
        let typed = b" . /tmp/.t-AbCd012345;rm -f /tmp/.t-AbCd012345\n";
        let mut filter = SshBootstrapOutputFilter::new(typed, BOOTSTRAP_COMPLETION);

        assert_eq!(filter.push(b"motd\r\nrc> "), b"motd\r\n");
        assert!(filter
            .expire_prompt_hold(Instant::now() + BOOTSTRAP_PROMPT_HOLD / 2)
            .is_empty());
        assert_eq!(
            filter.expire_prompt_hold(Instant::now() + BOOTSTRAP_PROMPT_HOLD),
            b"rc> "
        );

        let mut visible = filter.push(b"\r\n");
        visible.extend(filter.push(BASH_PROMPT));
        visible.extend(filter.push(&typed[..typed.len() - 1]));
        visible.extend(filter.push(b"\r\n\x1b[?2004l\r"));
        visible.extend(filter.push(BOOTSTRAP_COMPLETION));
        visible.extend(filter.push(RESTORED_PROMPT));
        assert!(filter.is_complete());
        assert_no_bootstrap_text(&visible);
        assert!(visible.ends_with(RESTORED_PROMPT));
    }

    #[test]
    fn bootstrap_output_filter_flushes_an_unmatched_partial_prefix_on_finish() {
        let typed = b" . /tmp/.t-AbCd012345;rm -f /tmp/.t-AbCd012345\n";
        let completion = b"\x1b]777;tunara-bootstrap;session-1\x1b\\";
        let output = b"ordinary output ending in .";
        let mut filter = SshBootstrapOutputFilter::new(typed, completion);

        let mut visible = filter.push(output);
        visible.extend(filter.finish());

        assert_eq!(visible, output);
    }
}
