import type { Terminal } from "@xterm/xterm";

const MAX_PENDING_BYTES = 2 * 1024 * 1024;
export const MAX_TERMINAL_WRITE_BYTES = 128 * 1024;
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
  onOverflow?: (droppedBytes: number) => void;
}

interface PendingChunk {
  data: Uint8Array;
  acknowledge?: () => void;
}

export function createTerminalOutputBuffer(term: Terminal, {
  timeoutMs = TERMINAL_OUTPUT_FRAME_TIMEOUT_MS,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
  scheduleTimeout = (callback, delay) => setTimeout(callback, delay),
  cancelTimeout = (handle) => clearTimeout(handle),
  onOverflow,
}: TerminalOutputBufferOptions = {}) {
  let pending: PendingChunk[] = [];
  let pendingBytes = 0;
  let writeRafId = 0;
  let writeTimer: TimerHandle | null = null;
  let writeInFlight = false;
  let completeInFlight: (() => void) | null = null;
  let idleWaiters: Array<() => void> = [];

  const cancelPendingFlush = () => {
    if (writeRafId) cancelFrame(writeRafId);
    if (writeTimer !== null) cancelTimeout(writeTimer);
    writeRafId = 0;
    writeTimer = null;
  };

  const resolveIdle = () => {
    if (pending.length > 0 || writeInFlight) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const scheduleFlush = () => {
    if (writeInFlight || pending.length === 0 || writeRafId || writeTimer !== null) return;
    writeRafId = requestFrame(flush);
    writeTimer = scheduleTimeout(flush, timeoutMs);
  };

  function flush() {
    cancelPendingFlush();
    if (writeInFlight || pending.length === 0) {
      resolveIdle();
      return;
    }
    const batch: PendingChunk[] = [];
    let batchBytes = 0;
    while (pending.length > 0) {
      const next = pending[0];
      const room = MAX_TERMINAL_WRITE_BYTES - batchBytes;
      if (next.data.byteLength <= room) {
        pending.shift();
        batch.push(next);
        batchBytes += next.data.byteLength;
        pendingBytes -= next.data.byteLength;
        if (batchBytes === MAX_TERMINAL_WRITE_BYTES) break;
        continue;
      }
      if (room === 0) break;
      batch.push({ data: next.data.slice(0, room) });
      next.data = next.data.slice(room);
      batchBytes += room;
      pendingBytes -= room;
      break;
    }

    const payload = batch.length === 1
      ? batch[0].data
      : (() => {
        const merged = new Uint8Array(batchBytes);
        let offset = 0;
        for (const chunk of batch) {
          merged.set(chunk.data, offset);
          offset += chunk.data.byteLength;
        }
        return merged;
      })();
    const acknowledgements = batch.flatMap((chunk) => chunk.acknowledge ? [chunk.acknowledge] : []);
    writeInFlight = true;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      completeInFlight = null;
      writeInFlight = false;
      for (const callback of acknowledgements) callback();
      if (pending.length > 0) scheduleFlush();
      else resolveIdle();
    };
    completeInFlight = complete;
    term.write(payload, complete);
  }

  return {
    push(data: Uint8Array, onConsumed?: () => void) {
      if (pendingBytes + data.byteLength > MAX_PENDING_BYTES) {
        // This is a last-resort compatibility path for an older/no-ACK
        // backend. Current local and SSH producers are flow-controlled before
        // reaching this cap, so any hit remains a correctness failure in M1.
        onOverflow?.(pendingBytes);
        for (const chunk of pending) chunk.acknowledge?.();
        pending = [
          { data: OVERFLOW_NOTICE },
          { data, acknowledge: onConsumed },
        ];
        pendingBytes = OVERFLOW_NOTICE.byteLength + data.byteLength;
      } else {
        pending.push({ data, acknowledge: onConsumed });
        pendingBytes += data.byteLength;
      }
      scheduleFlush();
    },
    drain(): Promise<void> {
      if (pending.length === 0 && !writeInFlight) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
        scheduleFlush();
      });
    },
    dispose() {
      cancelPendingFlush();
      completeInFlight?.();
      cancelPendingFlush();
      for (const chunk of pending) chunk.acknowledge?.();
      pending = [];
      pendingBytes = 0;
      resolveIdle();
    },
  };
}
