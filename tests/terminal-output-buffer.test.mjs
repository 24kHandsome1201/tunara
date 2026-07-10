import assert from "node:assert/strict";
import test from "node:test";

// The module only type-imports Terminal, so it is Node-safe; the runtime
// browser surface it touches is requestAnimationFrame/cancelAnimationFrame,
// polyfilled here with a manual pump so each test controls flush timing.
const rafQueue = new Map();
let rafId = 1;
globalThis.requestAnimationFrame = (cb) => {
  const id = rafId++;
  rafQueue.set(id, cb);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  rafQueue.delete(id);
};
function pumpAnimationFrames() {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(performance.now());
}

const { createTerminalOutputBuffer } = await import(
  "../src/modules/terminal/lib/terminal-output-buffer.ts"
);

const MAX_PENDING_BYTES = 2 * 1024 * 1024;

function makeTerminalStub() {
  const writes = [];
  return {
    writes,
    term: {
      write(data) {
        writes.push(data);
      },
    },
  };
}

function text(bytes) {
  return new TextDecoder().decode(bytes);
}

test("buffered chunks merge into a single write per animation frame", () => {
  const { term, writes } = makeTerminalStub();
  const buffer = createTerminalOutputBuffer(term);
  buffer.push(new TextEncoder().encode("hello "));
  buffer.push(new TextEncoder().encode("world"));
  assert.equal(writes.length, 0, "nothing flushes before the frame");
  pumpAnimationFrames();
  assert.equal(writes.length, 1);
  assert.equal(text(writes[0]), "hello world");
  buffer.dispose();
});

test("backgrounded terminals flush when animation frames are suspended", () => {
  const { term, writes } = makeTerminalStub();
  let fireTimeout;
  let cancelledFrame;
  const buffer = createTerminalOutputBuffer(term, {
    requestFrame: () => 91,
    cancelFrame: (handle) => { cancelledFrame = handle; },
    scheduleTimeout: (callback) => {
      fireTimeout = callback;
      return 42;
    },
    cancelTimeout: () => {},
  });
  buffer.push(new TextEncoder().encode("remote OSC output"));
  assert.equal(writes.length, 0);
  fireTimeout();
  assert.equal(writes.length, 1);
  assert.equal(text(writes[0]), "remote OSC output");
  assert.equal(cancelledFrame, 91);
  buffer.dispose();
});

test("overflow drops the backlog but keeps the chunk that arrived", () => {
  const { term, writes } = makeTerminalStub();
  const buffer = createTerminalOutputBuffer(term);
  // Fill the pending buffer right up to the cap without flushing.
  buffer.push(new Uint8Array(MAX_PENDING_BYTES - 10).fill(0x61));
  // This chunk overflows: the backlog must be replaced by the reset notice,
  // and — matching the backend reader in session.rs — the TRIGGERING chunk
  // itself must survive after the notice rather than being discarded with
  // the backlog.
  const fresh = new TextEncoder().encode("FRESH-OUTPUT");
  buffer.push(fresh);
  pumpAnimationFrames();
  assert.equal(writes.length, 1);
  const flushed = text(writes[0]);
  assert.ok(
    flushed.includes("dropped frontend output backlog"),
    "overflow notice present",
  );
  assert.ok(flushed.startsWith("\x1bc"), "notice leads with a hard reset");
  assert.ok(flushed.endsWith("FRESH-OUTPUT"), "triggering chunk preserved after the notice");
  assert.ok(!flushed.includes("aaa"), "backlog dropped");
  buffer.dispose();
});

test("output after an overflow continues normally", () => {
  const { term, writes } = makeTerminalStub();
  const buffer = createTerminalOutputBuffer(term);
  buffer.push(new Uint8Array(MAX_PENDING_BYTES).fill(0x61));
  buffer.push(new TextEncoder().encode("first-after"));
  pumpAnimationFrames();
  buffer.push(new TextEncoder().encode("second-after"));
  pumpAnimationFrames();
  assert.equal(writes.length, 2);
  assert.ok(text(writes[0]).endsWith("first-after"));
  assert.equal(text(writes[1]), "second-after");
  buffer.dispose();
});

test("dispose cancels a pending flush", () => {
  const { term, writes } = makeTerminalStub();
  const buffer = createTerminalOutputBuffer(term);
  buffer.push(new TextEncoder().encode("never flushed"));
  buffer.dispose();
  pumpAnimationFrames();
  assert.equal(writes.length, 0);
});
