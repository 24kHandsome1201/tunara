import assert from "node:assert/strict";
import test from "node:test";
import { sameHerdrSummary, summarizeHerdrPanes } from "../src/modules/session/herdr-status.ts";

test("HerdR summary counts agent panes only and keeps the focused cwd", () => {
  const summary = summarizeHerdrPanes([
    { paneId: "a", focused: false, agent: "claude", agentStatus: "blocked", cwd: "/a" },
    { paneId: "b", focused: true, agent: null, agentStatus: "blocked", cwd: "/b" },
    { paneId: "c", focused: false, agent: "codex", agentStatus: "working", cwd: null },
    { paneId: "d", focused: false, agent: "codex", agentStatus: "done", cwd: null },
    { paneId: "e", focused: false, agent: "pi", agentStatus: "unknown", cwd: null },
  ]);
  assert.deepEqual(summary, { blocked: 1, working: 1, done: 1, focusedCwd: "/b" });
  assert.equal(sameHerdrSummary(summary, { ...summary }), true);
  assert.equal(sameHerdrSummary(summary, { ...summary, blocked: 2 }), false);
  assert.equal(sameHerdrSummary(null, null), true);
});
