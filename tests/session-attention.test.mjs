import assert from "node:assert/strict";
import test from "node:test";

import { deriveSessionAttention } from "../src/modules/session/session-attention.ts";

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

test("SSH failures and disconnects are derived as attention", () => {
  const groups = deriveSessionAttention([
    session("failed", { remote: { host: "a", port: 22, user: "root" }, connection: { transport: "ssh", phase: "failed", source: "backend", updatedAt: 2 } }),
    session("lost", { remote: { host: "b", port: 22, user: "root" }, connection: { transport: "ssh", phase: "disconnected", source: "transport", updatedAt: 3 } }),
  ]);
  assert.deepEqual(groups.attention.map((item) => item.kind), ["ssh-failed", "ssh-disconnected"]);
});

test("only unread completed work asks for attention", () => {
  const groups = deriveSessionAttention([
    session("agent-ready", { agent: "CC", agentActivity: "idle", unread: true }),
    session("agent-seen", { agent: "CX", agentActivity: "idle", unread: false }),
    session("command-failed", { runState: "failed", unread: true, lastCommand: "pnpm test" }),
    session("failure-seen", { runState: "failed", unread: false, lastCommand: "pnpm test" }),
  ]);
  assert.deepEqual(groups.attention.map((item) => item.kind), ["agent-ready", "command-failed"]);
  assert.deepEqual(groups.quiet.map((item) => item.id), ["agent-seen", "failure-seen"]);
});

test("agent confirmation always asks for attention below SSH failures and above completed work", () => {
  const groups = deriveSessionAttention([
    session("failed", { agent: "CC", agentActivity: "waiting_confirmation", remote: { host: "a", port: 22, user: "root" }, connection: { transport: "ssh", phase: "failed", source: "backend", updatedAt: 2 } }),
    session("confirm", { agent: "CX", agentActivity: "waiting_confirmation", unread: false }),
    session("ready", { agent: "CC", agentActivity: "idle", unread: true }),
  ]);
  assert.deepEqual(groups.attention.map((item) => item.kind), ["ssh-failed", "agent-confirmation", "agent-ready"]);
  assert.equal(groups.running.length, 0);
  assert.equal(groups.quiet.length, 0);
});

test("running and resumable sessions are mutually exclusive derived groups", () => {
  const groups = deriveSessionAttention([
    session("shell", { runState: "running" }),
    session("agent", { agent: "CC", agentActivity: "starting" }),
    session("resume", { agentResume: { agent: "CX", command: "codex", cwd: "/repo", resumeId: "abc", lastSeenAt: 1, confidence: "exact" } }),
  ]);
  assert.deepEqual(groups.running.map((item) => item.id), ["shell", "agent"]);
  assert.equal(groups.resumable.length, 1);
  assert.match(groups.resumable[0].resumeCommand, /codex resume abc/);
  assert.equal(groups.total, 3);
});
