import assert from "node:assert/strict";
import test from "node:test";

// Regression guard for the "text garbles DURING sustained output, fixed by
// resizing" bug (xterm.js #6038 / #4534, addon-webgl 0.19). Heavy output with
// many distinct glyphs corrupts the shared WebGL texture atlas; the focus /
// resize self-heal paths never fire while the user is watching output stream
// in, so the app rebuilds the atlas itself under output pressure. These tests
// pin the pressure monitor's contract (threshold, rate limit, trailing quiet
// rebuild) and the global rebuild registry semantics.

const KiB = 1024;

function createMonitorHarness(overrides = {}) {
  let currentTime = 0;
  const timers = new Map();
  let nextTimerId = 1;
  let rebuilds = 0;
  const harness = {
    advance(ms) {
      currentTime += ms;
    },
    fireQuietTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const cb of due) cb();
    },
    get pendingTimerCount() {
      return timers.size;
    },
    get rebuilds() {
      return rebuilds;
    },
  };
  return {
    harness,
    options: {
      thresholdBytes: 100 * KiB,
      minIntervalMs: 10_000,
      quietMs: 300,
      now: () => currentTime,
      schedule: (cb) => {
        const id = nextTimerId++;
        timers.set(id, cb);
        return id;
      },
      cancel: (id) => {
        timers.delete(id);
      },
      ...overrides,
    },
    rebuild: () => {
      rebuilds += 1;
    },
  };
}

test("crossing the byte threshold triggers an immediate rebuild", async () => {
  const { createTerminalAtlasPressureMonitor } = await import(
    "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
  );
  const { harness, options, rebuild } = createMonitorHarness();
  const monitor = createTerminalAtlasPressureMonitor(rebuild, options);

  monitor.push(60 * KiB);
  assert.equal(harness.rebuilds, 0, "below threshold: no rebuild");
  monitor.push(60 * KiB);
  assert.equal(harness.rebuilds, 1, "threshold crossed: rebuild fired");
});

test("rebuilds are rate-limited; a trailing quiet rebuild covers the gap", async () => {
  const { createTerminalAtlasPressureMonitor } = await import(
    "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
  );
  const { harness, options, rebuild } = createMonitorHarness();
  const monitor = createTerminalAtlasPressureMonitor(rebuild, options);

  monitor.push(120 * KiB);
  assert.equal(harness.rebuilds, 1, "first crossing rebuilds immediately");

  // Second crossing arrives 1s later — inside the 10s rate-limit window.
  harness.advance(1_000);
  monitor.push(120 * KiB);
  assert.equal(harness.rebuilds, 1, "rate-limited: no immediate rebuild");
  assert.equal(harness.pendingTimerCount, 1, "trailing quiet rebuild armed");

  // Output stops; the quiet timer fires and heals the final frame.
  harness.fireQuietTimers();
  assert.equal(harness.rebuilds, 2, "trailing quiet rebuild fired");
  assert.equal(harness.pendingTimerCount, 0, "no timer left behind");
});

test("sustained pressure rebuilds again once the rate-limit window elapses", async () => {
  const { createTerminalAtlasPressureMonitor } = await import(
    "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
  );
  const { harness, options, rebuild } = createMonitorHarness();
  const monitor = createTerminalAtlasPressureMonitor(rebuild, options);

  monitor.push(120 * KiB);
  assert.equal(harness.rebuilds, 1);

  harness.advance(5_000);
  monitor.push(120 * KiB);
  assert.equal(harness.rebuilds, 1, "still inside the rate-limit window");

  harness.advance(6_000); // 11s since last rebuild
  monitor.push(1 * KiB); // already past threshold; any output re-checks
  assert.equal(harness.rebuilds, 2, "rebuilds once the min interval elapsed");
  assert.equal(harness.pendingTimerCount, 0, "quiet timer cancelled by rebuild");
});

test("a rebuild resets the accumulator — no redundant trailing rebuild", async () => {
  const { createTerminalAtlasPressureMonitor } = await import(
    "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
  );
  const { harness, options, rebuild } = createMonitorHarness();
  const monitor = createTerminalAtlasPressureMonitor(rebuild, options);

  monitor.push(120 * KiB);
  assert.equal(harness.rebuilds, 1);

  // Sub-threshold trickle after the rebuild must not schedule or fire anything.
  harness.advance(1_000);
  monitor.push(10 * KiB);
  assert.equal(harness.pendingTimerCount, 0, "no quiet timer below threshold");
  harness.fireQuietTimers();
  assert.equal(harness.rebuilds, 1, "no redundant rebuild after the burst ended");
});

test("notifyRebuilt (resize/focus path) resets pressure state", async () => {
  const { createTerminalAtlasPressureMonitor } = await import(
    "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
  );
  const { harness, options, rebuild } = createMonitorHarness();
  const monitor = createTerminalAtlasPressureMonitor(rebuild, options);

  monitor.push(120 * KiB);
  harness.advance(1_000);
  monitor.push(120 * KiB); // rate-limited, quiet timer armed
  assert.equal(harness.pendingTimerCount, 1);

  monitor.notifyRebuilt(); // e.g. the user resized: atlas already rebuilt
  assert.equal(harness.pendingTimerCount, 0, "quiet timer cancelled");
  harness.fireQuietTimers();
  assert.equal(harness.rebuilds, 1, "no extra rebuild after an external one");

  // The rate-limit window also restarts from the external rebuild.
  harness.advance(1_000);
  monitor.push(120 * KiB);
  assert.equal(harness.rebuilds, 1, "still rate-limited relative to notifyRebuilt");
});

test("global rebuild invokes every registered rebuilder, isolating failures", async () => {
  const {
    registerTerminalAtlasRebuilder,
    requestGlobalTerminalAtlasRebuild,
  } = await import("../src/modules/terminal/lib/terminal-atlas-refresh.ts");

  const calls = [];
  const disposeA = registerTerminalAtlasRebuilder(() => calls.push("a"));
  const disposeThrowing = registerTerminalAtlasRebuilder(() => {
    calls.push("boom");
    throw new Error("renderer torn down");
  });
  const disposeB = registerTerminalAtlasRebuilder(() => calls.push("b"));
  try {
    requestGlobalTerminalAtlasRebuild();
    assert.deepEqual(calls, ["a", "boom", "b"], "all rebuilders ran; the throwing one did not block the rest");
  } finally {
    disposeA();
    disposeThrowing();
    disposeB();
  }
});

test("a disposed rebuilder is not invoked again", async () => {
  const {
    registerTerminalAtlasRebuilder,
    requestGlobalTerminalAtlasRebuild,
  } = await import("../src/modules/terminal/lib/terminal-atlas-refresh.ts");

  let calls = 0;
  const dispose = registerTerminalAtlasRebuilder(() => { calls += 1; });
  requestGlobalTerminalAtlasRebuild();
  assert.equal(calls, 1);
  dispose();
  requestGlobalTerminalAtlasRebuild();
  assert.equal(calls, 1, "unregistered rebuilder stays silent");
});

test("output pressure is ignored when no terminal is registered", async () => {
  const { recordTerminalAtlasOutputPressure } = await import(
    "../src/modules/terminal/lib/terminal-atlas-refresh.ts"
  );
  // Must not throw or arm timers with an empty registry (app shutdown races).
  recordTerminalAtlasOutputPressure(10 * 1024 * 1024);
});

test("aggregated output from multiple panes crosses the shared threshold", async () => {
  const {
    registerTerminalAtlasRebuilder,
    recordTerminalAtlasOutputPressure,
    ATLAS_PRESSURE_THRESHOLD_BYTES,
  } = await import("../src/modules/terminal/lib/terminal-atlas-refresh.ts");

  let rebuilds = 0;
  const dispose = registerTerminalAtlasRebuilder(() => { rebuilds += 1; });
  try {
    // Two "panes" each push slightly more than half the threshold: only their
    // sum crosses it, proving the monitor is a single shared instance.
    const half = Math.ceil(ATLAS_PRESSURE_THRESHOLD_BYTES / 2);
    recordTerminalAtlasOutputPressure(half);
    assert.equal(rebuilds, 0, "half the threshold from pane A: no rebuild");
    recordTerminalAtlasOutputPressure(half);
    assert.equal(rebuilds, 1, "pane B's bytes complete the shared threshold");
  } finally {
    dispose();
  }
});
