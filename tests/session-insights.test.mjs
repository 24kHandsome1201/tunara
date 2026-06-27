import assert from "node:assert/strict";
import test from "node:test";

import {
  pickSessionNudgeIndex,
  summarizeChangedFiles,
} from "../src/modules/session/session-insights.ts";

test("summarizeChangedFiles totals diff stats and buckets stages", () => {
  assert.deepEqual(
    summarizeChangedFiles([
      { stage: "staged", added: 2, removed: 1 },
      { stage: "unstaged", added: 3.9, removed: 0 },
      { stage: "untracked", added: Number.NaN, removed: -1 },
    ]),
    { fileCount: 3, added: 5, removed: 1, staged: 1, unstaged: 1, untracked: 1 },
  );
});

test("pickSessionNudgeIndex is deterministic per seed and day", () => {
  const now = Date.UTC(2026, 0, 2, 12);
  assert.equal(pickSessionNudgeIndex("session-a", now, 6), pickSessionNudgeIndex("session-a", now, 6));
  assert.ok(pickSessionNudgeIndex("session-a", now, 6) >= 0);
  assert.ok(pickSessionNudgeIndex("session-a", now, 6) < 6);
  assert.equal(pickSessionNudgeIndex("session-a", now, 0), 0);
});
