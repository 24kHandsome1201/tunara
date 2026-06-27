import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFocusQuest,
  buildWorkspaceInsights,
  formatWorkspaceDigest,
} from "../src/modules/workspace/insights.ts";

function session(overrides = {}) {
  return {
    id: overrides.id ?? "s1",
    title: "Terminal",
    dir: overrides.dir ?? "/repo",
    branch: overrides.branch ?? "main",
    runState: overrides.runState ?? "idle",
    updatedAt: overrides.updatedAt ?? 1,
    ...overrides,
  };
}

test("workspace insights summarizes local, remote, agent, unread, and change signals", () => {
  const now = 1_800_000;
  const insights = buildWorkspaceInsights([
    session({
      id: "local-dirty",
      changes: {
        summary: "1 file",
        files: [
          { path: "src/a.ts", status: "modified", stage: "unstaged", added: 12, removed: 3 },
          { path: "src/b.ts", status: "modified", stage: "unstaged", added: 5, removed: 1 },
        ],
      },
    }),
    session({ id: "agent", agent: "CC", agentActivity: "running", runState: "running", unread: true }),
    session({ id: "remote", dir: "me@box", remote: { host: "box", port: 22, user: "me" } }),
    session({ id: "done", runState: "done", completedAt: 0 }),
  ], now);

  assert.equal(insights.stats.totalSessions, 4);
  assert.equal(insights.stats.localSessions, 3);
  assert.equal(insights.stats.remoteSessions, 1);
  assert.equal(insights.stats.agentSessions, 1);
  assert.equal(insights.stats.busyAgents, 1);
  assert.equal(insights.stats.unreadSessions, 1);
  assert.equal(insights.stats.changedFiles, 2);
  assert.equal(insights.stats.changedRepos, 1);
  assert.equal(insights.stats.addedLines, 17);
  assert.equal(insights.stats.removedLines, 4);
  assert.equal(insights.stats.staleDoneSessions, 1);
  assert.equal(insights.mood, "hot");
  assert.ok(insights.intensity > 0);
  assert.deepEqual(insights.signals.map((s) => s.kind), [
    "agents_running",
    "review_changes",
    "unread_sessions",
    "remote_sessions",
    "cleanup_finished",
  ]);
});

test("workspace insights returns a calm signal for a quiet workspace", () => {
  const insights = buildWorkspaceInsights([session()]);
  assert.equal(insights.mood, "calm");
  assert.equal(insights.intensity, 0);
  assert.deepEqual(insights.signals.map((s) => s.kind), ["calm"]);
  assert.deepEqual(buildFocusQuest(insights), [
    { kind: "enjoy_calm", count: 1, completed: true },
  ]);
});

test("focus quest prioritizes active work and limits the list", () => {
  const insights = buildWorkspaceInsights([
    session({ id: "agent", agent: "CC", agentActivity: "running", runState: "running" }),
    session({ id: "dirty", changes: { summary: "x", files: [{ path: "x", status: "modified", stage: "unstaged", added: 1, removed: 0 }] } }),
    session({ id: "unread", unread: true }),
    session({ id: "done", runState: "done", completedAt: 0 }),
    session({ id: "remote", remote: { host: "box", port: 22, user: "me" } }),
  ], 2_000_000);

  assert.deepEqual(buildFocusQuest(insights).map((s) => s.kind), [
    "watch_agents",
    "review_changes",
    "clear_unread",
    "clean_finished",
  ]);
});

test("workspace digest contains stable headline values", () => {
  const insights = buildWorkspaceInsights([session({ id: "dirty", changes: { summary: "x", files: [{ path: "x", status: "modified", stage: "unstaged", added: 3, removed: 2 }] } })]);
  const digest = formatWorkspaceDigest(insights);
  assert.match(digest, /Workspace /);
  assert.match(digest, /Mood: review/);
  assert.match(digest, /Sessions: 1 total/);
  assert.match(digest, /Changes: 1 files across 1 repos, \+3\/-2/);
});
