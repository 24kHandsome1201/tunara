import test from "node:test";
import assert from "node:assert/strict";

import {
  percentile,
  scanBenchmarkMarker,
  summarizeDurations,
  TerminalOutputSequenceTracker,
  TERMINAL_OUTPUT_BLOCK_BYTES,
  terminalOutputBlockHeader,
} from "../src/modules/terminal/lib/terminal-benchmark.ts";

test("terminal benchmark percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([9, 1, 7, 3, 5], 0.5), 5);
  assert.equal(percentile([9, 1, 7, 3, 5], 0.95), 9);
  assert.equal(percentile([2, 4], -1), 2);
  assert.equal(percentile([2, 4], 2), 4);
});

test("terminal benchmark marker survives an output chunk boundary", () => {
  const marker = "__TUNARA_M0_9_abc__";
  const first = scanBenchmarkMarker("", `prompt ${marker.slice(0, 11)}`, marker);
  assert.equal(first.matched, false);
  const second = scanBenchmarkMarker(first.tail, `${marker.slice(11)} rest`, marker);
  assert.equal(second.matched, true);
});

test("terminal benchmark duration summary is stable and rounded", () => {
  assert.deepEqual(summarizeDurations([]), {
    count: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
  assert.deepEqual(summarizeDurations([16.666, 16.777, 24.125]), {
    count: 3,
    p50Ms: 16.78,
    p95Ms: 24.13,
    maxMs: 24.13,
  });
});

function framedOutput(nonce, payload) {
  const start = new TextEncoder().encode(`noise__TUNARA_M1_BEGIN_${nonce}__\n`);
  const end = new TextEncoder().encode(`\n__TUNARA_M1_END_${nonce}__ blocks=2\n`);
  const bytes = new Uint8Array(start.length + payload.length + end.length);
  bytes.set(start);
  bytes.set(payload, start.length);
  bytes.set(end, start.length + payload.length);
  return bytes;
}

test("M1 output sequence tracker survives arbitrary IPC chunk boundaries", () => {
  const nonce = "chunk_boundary";
  const payload = new Uint8Array(TERMINAL_OUTPUT_BLOCK_BYTES * 2).fill(0x2e);
  payload.set(terminalOutputBlockHeader(0), 0);
  payload.set(terminalOutputBlockHeader(1), TERMINAL_OUTPUT_BLOCK_BYTES);
  const framed = framedOutput(nonce, payload);
  const tracker = new TerminalOutputSequenceTracker(payload.length, nonce);
  let result = null;
  for (let offset = 0; offset < framed.length;) {
    const take = Math.min(framed.length - offset, (offset % 997) + 1);
    result = tracker.push(framed.slice(offset, offset + take)) ?? result;
    offset += take;
  }
  assert.equal(result?.receivedBytes, payload.length);
  assert.equal(result?.expectedBlocks, 2);
  assert.equal(result?.sequenceValid, true);
  assert.equal(result?.firstSequenceError, null);
  assert.ok(result?.dataEvents > 2);
});

test("M1 output sequence tracker detects dropped or reordered blocks", () => {
  const nonce = "bad_sequence";
  const payload = new Uint8Array(TERMINAL_OUTPUT_BLOCK_BYTES * 2).fill(0x2e);
  payload.set(terminalOutputBlockHeader(0), 0);
  payload.set(terminalOutputBlockHeader(0), TERMINAL_OUTPUT_BLOCK_BYTES);
  const tracker = new TerminalOutputSequenceTracker(payload.length, nonce);
  const result = tracker.push(framedOutput(nonce, payload));
  assert.equal(result?.sequenceValid, false);
  assert.match(result?.firstSequenceError ?? "", /block 1 header mismatch/);
});
