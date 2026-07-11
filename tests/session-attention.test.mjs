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
    session("resume", { agentResume: { agent: "CX", command: "codex", cwd: "/repo", provenance: { transport: "local" }, resumeId: "abc", lastSeenAt: 1, confidence: "exact" } }),
  ]);
  assert.deepEqual(groups.running.map((item) => item.id), ["shell", "agent"]);
  assert.equal(groups.resumable.length, 1);
  assert.match(groups.resumable[0].resumeCommand, /codex resume abc/);
  assert.match(groups.resumable[0].resumeCommand, /^cd -- \/repo &&/);
  assert.equal(groups.total, 3);
});

test("global attention uses cwd-aware commands and hides cross-transport resume intents", () => {
  const piResume = {
    agent: "PI",
    command: "npx -y @earendil-works/pi-coding-agent@0.79.4 --session pi-id",
    cwd: "/root/original repo",
    provenance: { transport: "ssh", host: "de-netcup", port: 22, user: "root" },
    resumeId: "pi-id",
    lastSeenAt: 1,
    confidence: "exact",
  };
  const groups = deriveSessionAttention([
    session("same-host", {
      dir: "/tmp",
      remote: { host: "de-netcup", port: 22, user: "root" },
      connection: { phase: "ready" },
      agentResume: piResume,
    }),
    session("other-host", {
      dir: "/tmp",
      remote: { host: "other", port: 22, user: "root" },
      connection: { phase: "ready" },
      agentResume: piResume,
    }),
  ]);
  assert.equal(groups.resumable.length, 1);
  assert.equal(
    groups.resumable[0].resumeCommand,
    "cd -- '/root/original repo' && npx -y @earendil-works/pi-coding-agent@0.79.4 --session pi-id",
  );
  assert.deepEqual(groups.quiet.map((item) => item.id), ["other-host"]);
});
