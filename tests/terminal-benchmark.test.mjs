import test from "node:test";
import assert from "node:assert/strict";

import {
  percentile,
  scanBenchmarkMarker,
  summarizeDurations,
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
