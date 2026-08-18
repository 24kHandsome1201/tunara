import test from "node:test";
import assert from "node:assert/strict";
import { deltaFrontendPerf, pairedBenchmarkRecord, recordFrontendPerf, resetFrontendPerf, snapshotFrontendPerf } from "../src/modules/perf/benchmark-counters.ts";

test("frontend benchmark counters reset, snapshot, delta, and pair without product subscriptions", () => {
  resetFrontendPerf();
  const baseline = snapshotFrontendPerf();
  recordFrontendPerf("transferStoreWrites", 2);
  recordFrontendPerf("renders");
  const after = snapshotFrontendPerf();
  assert.deepEqual(deltaFrontendPerf(after, baseline), {
    transferStoreWrites: 2, treeStoreWrites: 0, persistenceStoreWrites: 0, renders: 1,
    workspaceProjections: 0, persistenceIpc: 0, persistenceDebounceMerges: 0,
    terminalBackstopFlushes: 0, closeFlushes: 0, gitWatchAcquires: 0, gitWatchReleases: 0,
  });
  assert.deepEqual(pairedBenchmarkRecord(baseline, after), { baseline, after });
  resetFrontendPerf();
  assert.deepEqual(snapshotFrontendPerf(), baseline);
});
