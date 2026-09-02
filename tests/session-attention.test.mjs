import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAttentionRow,
  dockBadgeCount,
  groupCue,
  nextAttentionSessionId,
  sessionCue,
} from "../src/modules/session/session-attention.ts";

function session(id, patch = {}) {
  return {
    id,
    title: id,
    dir: "/tmp",
    branch: "",
    runState: "idle",
    updatedAt: 1,
    ...patch,
  };
}

test("sessionCue is one slot: needs-you outranks unread, running is not a cue", () => {
  assert.equal(sessionCue(session("wait", { agent: "CC", agentActivity: "waiting_confirmation", unread: true })), "needs-you");
  assert.equal(sessionCue(session("unread", { unread: true, agent: "CC", agentActivity: "idle" })), "unread");
  assert.equal(sessionCue(session("running", { agent: "CC", agentActivity: "running" })), null);
  assert.equal(sessionCue(session("quiet")), null);
});

test("groupCue rolls the same one-slot priority up to a directory header", () => {
  assert.equal(groupCue([
    session("unread", { unread: true }),
    session("wait", { agent: "CC", agentActivity: "waiting_confirmation" }),
  ]), "needs-you");
  assert.equal(groupCue([
    session("quiet"),
    session("unread", { unread: true }),
  ]), "unread");
  assert.equal(groupCue([
    session("running", { agent: "CC", agentActivity: "starting" }),
  ]), null);
});

test("attention row shows needs-you over running, and hides when neither exists", () => {
  assert.deepEqual(
    deriveAttentionRow([
      session("wait", { agent: "CC", agentActivity: "waiting_confirmation" }),
      session("run", { agent: "CX", agentActivity: "running" }),
    ]),
    { kind: "needs-you", count: 1 },
  );
  assert.deepEqual(
    deriveAttentionRow([
      session("run", { agent: "CC", agentActivity: "starting" }),
      session("shell", { runState: "running" }),
    ]),
    { kind: "running", count: 1 },
  );
  assert.deepEqual(
    deriveAttentionRow([
      session("unread", { unread: true }),
      session("resume", { agentResume: { agent: "CX", command: "codex", cwd: "/repo" } }),
    ]),
    { kind: null, count: 0 },
  );
});

test("dock badge N matches the sidebar needs-you count and ignores unread/running", () => {
  const sessions = [
    session("wait-a", { agent: "CC", agentActivity: "waiting_confirmation" }),
    session("wait-b", { agent: "CX", agentActivity: "waiting_confirmation", unread: true }),
    session("unread", { unread: true }),
    session("run", { agent: "CC", agentActivity: "running" }),
  ];
  const row = deriveAttentionRow(sessions);
  assert.equal(row.kind, "needs-you");
  assert.equal(row.count, 2);
  assert.equal(dockBadgeCount(sessions), row.count);
  assert.equal(dockBadgeCount([]), 0);
});

test("nextAttentionSessionId picks the earliest waiter FIFO, then latest unread", () => {
  const sessions = [
    session("quiet"),
    session("wait-later", { agent: "CC", agentActivity: "waiting_confirmation", updatedAt: 30 }),
    session("wait-earlier", { agent: "CX", agentActivity: "waiting_confirmation", updatedAt: 10 }),
    session("unread-old", { unread: true, updatedAt: 5 }),
    session("unread-new", { unread: true, updatedAt: 40 }),
  ];
  assert.equal(nextAttentionSessionId([], null), null);
  assert.equal(nextAttentionSessionId(sessions, null), "wait-earlier");
  assert.equal(nextAttentionSessionId(sessions, "wait-later"), "wait-earlier");
  assert.equal(
    nextAttentionSessionId([
      session("unread-old", { unread: true, updatedAt: 5 }),
      session("unread-new", { unread: true, updatedAt: 40 }),
      session("quiet"),
    ], null),
    "unread-new",
  );
});

test("FIFO waiting ties break by session list order", () => {
  const sessions = [
    session("second", { agent: "CC", agentActivity: "waiting_confirmation", updatedAt: 7 }),
    session("first", { agent: "CX", agentActivity: "waiting_confirmation", updatedAt: 7 }),
  ];
  assert.equal(nextAttentionSessionId(sessions, null), "second");
});
