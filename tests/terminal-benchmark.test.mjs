import test from "node:test";
import assert from "node:assert/strict";

import {
  compareRendererBenchmarkReports,
  evaluateAnimationFrames,
  mebibytesPerSecond,
  percentile,
  renderRendererComparisonMarkdown,
  resolveBenchmarkRendererOverride,
  scanBenchmarkMarker,
  summarizeDurations,
  TerminalOutputSequenceTracker,
  TERMINAL_OUTPUT_BLOCK_BYTES,
  terminalOutputBlockHeader,
} from "../src/modules/terminal/lib/terminal-benchmark.ts";

test("terminal benchmark separates intentional background rAF suspension from visible frame time", () => {
  const visible = Array.from({ length: 120 }, () => 16.7);
  const backgrounded = evaluateAnimationFrames([...visible.slice(0, 20), 5_215]);
  assert.equal(backgrounded.backgroundRafSuspended, true);
  assert.equal(backgrounded.frameSampleValid, false);
  assert.equal(backgrounded.frames.p95Ms, 16.7);
  assert.equal(backgrounded.passed, true);

  const visibleJank = evaluateAnimationFrames([...visible, ...Array.from({ length: 10 }, () => 80)]);
  assert.equal(visibleJank.backgroundRafSuspended, false);
  assert.equal(visibleJank.frameSampleValid, true);
  assert.equal(visibleJank.passed, false);
});

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

test("benchmark builds pin the renderer instead of running the glyph self-check", () => {
  assert.equal(resolveBenchmarkRendererOverride(false, "dom"), null);
  assert.equal(resolveBenchmarkRendererOverride(true, undefined), "gpu");
  assert.equal(resolveBenchmarkRendererOverride(true, "webgl"), "gpu");
  assert.equal(resolveBenchmarkRendererOverride(true, "dom"), "compat");
});

test("renderer comparison table reports throughput and four-pane frame time side by side", () => {
  const report = (renderer, scale) => ({
    benchmark: "renderer",
    renderer,
    timestamp: "2026-01-01T00:00:00.000Z",
    paneRenderers: [renderer, renderer, renderer, renderer],
    throughput: {
      bytes: 50 * 1024 * 1024,
      elapsedMs: 1000 * scale,
      mebibytesPerSecond: mebibytesPerSecond(50 * 1024 * 1024, 1000 * scale),
      renderDrainMs: 12 * scale,
      referenceVisible: true,
      sequenceValid: true,
      frames: summarizeDurations([16, 17, 18]),
    },
    fourPane: {
      panes: 4,
      bytesPerPane: 8 * 1024 * 1024,
      elapsedMs: 2000 * scale,
      frames: summarizeDurations([16, 20, 40 * scale]),
      frameP95BudgetMs: 33.4,
      referencesVisible: 4,
    },
    passed: true,
  });
  const rows = compareRendererBenchmarkReports(report("webgl", 1), report("dom", 2));
  const byMetric = Object.fromEntries(rows.map((row) => [row.metric, row]));
  assert.equal(byMetric["large output throughput"].webgl, "50.00 MiB/s (50 MiB in 1000 ms)");
  assert.equal(byMetric["large output throughput"].dom, "25.00 MiB/s (50 MiB in 2000 ms)");
  assert.equal(byMetric["4-pane frame p50 / p95 / max"].dom, "20.00 ms / 80.00 ms / 80.00 ms");
  assert.equal(byMetric["panes on requested renderer"].webgl, "4/4");
  const markdown = renderRendererComparisonMarkdown(rows);
  assert.match(markdown, /^\| Metric \| WebGL \| DOM \|\n\| --- \| --- \| --- \|\n/);
  assert.equal(markdown.split("\n").length, rows.length + 2);
  assert.equal(mebibytesPerSecond(1024, 0), 0);
});
