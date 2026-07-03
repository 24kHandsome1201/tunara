import type { Terminal } from "@xterm/xterm";

const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const OVERFLOW_NOTICE = new TextEncoder().encode(
  "\x1bc\x1b[2m[tunara: dropped frontend output backlog]\x1b[0m\r\n",
);

export function createTerminalOutputBuffer(term: Terminal) {
  let pendingData: Uint8Array[] = [];
  let pendingBytes = 0;
  let writeRafId = 0;

  const flush = () => {
    writeRafId = 0;
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
      if (!writeRafId) writeRafId = requestAnimationFrame(flush);
    },
    dispose() {
      if (writeRafId) cancelAnimationFrame(writeRafId);
      writeRafId = 0;
      pendingData = [];
      pendingBytes = 0;
    },
  };
}
