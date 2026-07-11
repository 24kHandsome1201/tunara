import assert from "node:assert/strict";
import test from "node:test";

import { groupAgentActivity } from "../src/modules/agent/global-activity.ts";

function session(id, patch = {}) {
  return { id, title: "终端", dir: "~", branch: "", runState: "idle", updatedAt: 0, ...patch };
}

test("groupAgentActivity returns empty groups for plain shell sessions", () => {
  const groups = groupAgentActivity([session("a"), session("b", { lastCommand: "ls" })]);
  assert.equal(groups.total, 0);
  assert.deepEqual(groups.wait, []);
  assert.deepEqual(groups.confirmation, []);
  assert.deepEqual(groups.run, []);
  assert.deepEqual(groups.resumable, []);
});

test("busy agents (starting/running) land in run", () => {
  const starting = session("a", { agent: "CC", agentActivity: "starting" });
  const running = session("b", { agent: "CX", agentActivity: "running" });
  const groups = groupAgentActivity([starting, running]);
  assert.deepEqual(groups.run.map((s) => s.id), ["a", "b"]);
  assert.equal(groups.wait.length, 0);
  assert.equal(groups.total, 2);
});

test("idle live agents land in wait (waiting for the user)", () => {
  const idle = session("a", { agent: "CC", agentActivity: "idle" });
  const groups = groupAgentActivity([idle]);
  assert.deepEqual(groups.wait.map((s) => s.id), ["a"]);
  assert.equal(groups.run.length, 0);
});

test("confirmation-blocked agents have an independent non-running group", () => {
  const groups = groupAgentActivity([session("a", { agent: "CC", agentActivity: "waiting_confirmation" })]);
  assert.deepEqual(groups.confirmation.map((s) => s.id), ["a"]);
  assert.equal(groups.wait.length, 0);
  assert.equal(groups.run.length, 0);
  assert.equal(groups.total, 1);
});

test("exited agents with a resume intent land in resumable with the built command", () => {
  const exited = session("a", {
    agentResume: { agent: "CC", command: "claude", cwd: "~", resumeId: "abc", lastSeenAt: 1, confidence: "exact" },
  });
  const groups = groupAgentActivity([exited]);
  assert.equal(groups.resumable.length, 1);
  assert.equal(groups.resumable[0].session.id, "a");
  assert.equal(groups.resumable[0].resumeCommand, "claude --resume abc");
});

test("resumable agents return to their captured cwd before launch", () => {
  const groups = groupAgentActivity([
    session("resume", {
      dir: "/current-repo",
      agentResume: {
        agent: "CX",
        command: "codex --sandbox read-only",
        cwd: "/original repo",
        resumeId: "thread-1",
        lastSeenAt: 1,
        confidence: "exact",
      },
    }),
  ]);
  assert.equal(
    groups.resumable[0]?.resumeCommand,
    "cd -- '/original repo' && codex --sandbox read-only resume thread-1",
  );
});

test("resume intents that build no command (unsupported agent) are excluded", () => {
  const exited = session("a", {
    agentResume: { agent: "GM", command: "gemini", cwd: "~", lastSeenAt: 1, confidence: "unknown" },
  });
  const groups = groupAgentActivity([exited]);
  assert.equal(groups.total, 0);
});

test("a live agent session is never double-counted as resumable", () => {
  const live = session("a", {
    agent: "CC",
    agentActivity: "idle",
    agentResume: { agent: "CC", command: "claude", cwd: "~", resumeId: "abc", lastSeenAt: 1, confidence: "exact" },
  });
  const groups = groupAgentActivity([live]);
  assert.equal(groups.wait.length, 1);
  assert.equal(groups.resumable.length, 0);
  assert.equal(groups.total, 1);
});
