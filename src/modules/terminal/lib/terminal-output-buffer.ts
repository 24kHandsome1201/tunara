import type { Terminal } from "@xterm/xterm";

const MAX_PENDING_BYTES = 2 * 1024 * 1024;
export const TERMINAL_OUTPUT_FRAME_TIMEOUT_MS = 120;
const OVERFLOW_NOTICE = new TextEncoder().encode(
  "\x1bc\x1b[2m[tunara: dropped frontend output backlog]\x1b[0m\r\n",
);

type TimerHandle = ReturnType<typeof setTimeout>;

interface TerminalOutputBufferOptions {
  timeoutMs?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => TimerHandle;
  cancelTimeout?: (handle: TimerHandle) => void;
}

export function createTerminalOutputBuffer(term: Terminal, {
  timeoutMs = TERMINAL_OUTPUT_FRAME_TIMEOUT_MS,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  cancelTimeout = (handle) => clearTimeout(handle),
}: TerminalOutputBufferOptions = {}) {
  let pendingData: Uint8Array[] = [];
  let pendingBytes = 0;
  let writeRafId = 0;
  let writeTimer: TimerHandle | null = null;

  const cancelPendingFlush = () => {
    if (writeRafId) cancelFrame(writeRafId);
    if (writeTimer !== null) cancelTimeout(writeTimer);
    writeRafId = 0;
    writeTimer = null;
  };

  const flush = () => {
    cancelPendingFlush();
    if (pendingData.length === 1) {
      term.write(pendingData[0]);
    } else if (pendingData.length > 1) {
      const merged = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const data of pendingData) {
        merged.set(data, offset);
        offset += data.length;
      }
      term.write(merged);
    }
    pendingData = [];
    pendingBytes = 0;
  };

  return {
    push(data: Uint8Array) {
      if (pendingBytes + data.byteLength > MAX_PENDING_BYTES) {
        // Drop the BACKLOG, keep the chunk that arrived — mirroring the
        // backend reader (session.rs), which clears its pending buffer and
        // then appends the new read. Dropping the incoming chunk too would
        // discard fresh bytes for no reason and let the next kept chunk start
        // mid-escape-sequence relative to it; the notice's ESC c reset plus
        // the preserved chunk keep the stream consistent. A single chunk can
        // never exceed the cap by itself: the backend flushes at most
        // ~1 MiB + one read per Data event, half this budget.
        pendingData = [OVERFLOW_NOTICE, data];
        pendingBytes = OVERFLOW_NOTICE.byteLength + data.byteLength;
      } else {
        pendingData.push(data);
        pendingBytes += data.byteLength;
      }
      if (!writeRafId && writeTimer === null) {
        writeRafId = requestFrame(flush);
        writeTimer = scheduleTimeout(flush, timeoutMs);
      }
    },
    dispose() {
      cancelPendingFlush();
      pendingData = [];
      pendingBytes = 0;
    },
  };
}
