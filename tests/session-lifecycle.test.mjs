import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDetectedUpdate,
  agentReadyUpdate,
  agentWaitingConfirmationUpdate,
  agentBusyUpdate,
  agentExitedUpdate,
  commandDetectedUpdate,
  commandFinishedUpdate,
  terminalExitedUpdate,
  cwdChangedUpdate,
  shellTitleUpdate,
} from "../src/modules/terminal/lib/session-lifecycle.ts";

const NOW = 1_000_000;

function baseSession(overrides = {}) {
  return {
    id: "s1",
    title: "Terminal",
    dir: "/home/user",
    branch: "",
    runState: "idle",
    updatedAt: NOW,
    ...overrides,
  };
}

function apply(session, update) {
  if (!update) return session;
  return { ...session, ...update.patch };
}

test("agent lifecycle: detected → busy → ready → exited clears agent and marks done/failed", () => {
  let s = baseSession();

  // 1. Agent detected — sets agent, resets run state to idle.
  const detected = agentDetectedUpdate(s, "CC", NOW);
  assert.ok(detected, "agentDetectedUpdate should produce a patch");
  s = apply(s, detected);
  assert.equal(s.agent, "CC");
  assert.equal(s.agentActivity, "starting");
  assert.equal(s.runState, "idle");
  assert.equal(s.startedAt, NOW);

  // 2. Agent goes busy — running activity, startedAt reset, unread cleared.
  const busy = agentBusyUpdate(s, NOW + 100);
  assert.ok(busy);
  s = apply(s, busy);
  assert.equal(s.agentActivity, "running");
  assert.equal(s.runState, "idle");
  assert.equal(s.unread, false);

  // 3. Agent ready (turn completed) — back to idle, completedAt set, unread if inactive.
  const ready = agentReadyUpdate(s, false, NOW + 200);
  assert.ok(ready);
  s = apply(s, ready);
  assert.equal(s.agentActivity, "idle");
  assert.equal(s.completedAt, NOW + 200);
  assert.equal(s.unread, true, "inactive session should get unread on turn completion");

  // 4. Agent exits — agent cleared, runState done/failed based on exit code.
  const exited = agentExitedUpdate(s, 0, false, NOW + 300);
  assert.ok(exited);
  s = apply(s, exited);
  assert.equal(s.agent, undefined);
  assert.equal(s.agentActivity, undefined);
  assert.equal(s.runState, "done");
  assert.equal(s.lastExitCode, 0);
  assert.equal(s.unread, true);
});

test("agent lifecycle: non-zero exit code marks failed", () => {
  let s = apply(baseSession({ agentResume: { agent: "CX", command: "codex", cwd: "/tmp", lastSeenAt: NOW, confidence: "unknown" } }), agentDetectedUpdate(baseSession(), "CX", NOW));
  s = apply(s, agentExitedUpdate(s, 1, true, NOW + 50));
  assert.equal(s.runState, "failed");
  assert.equal(s.lastExitCode, 1);
  assert.equal(s.agentResume, undefined, "a launch that fails before ready must not leave a false resume card");
  // Active session should NOT get unread on exit.
  assert.equal(s.unread, undefined);
});

test("agentDetectedUpdate is idempotent when the same agent is already set", () => {
  const s = apply(baseSession(), agentDetectedUpdate(baseSession(), "CC", NOW));
  const again = agentDetectedUpdate(s, "CC", NOW + 100);
  assert.equal(again, null, "re-detecting the same agent should not produce a patch");
});

test("agentBusyUpdate is a no-op when already running", () => {
  let s = apply(baseSession(), agentDetectedUpdate(baseSession(), "CC", NOW));
  s = apply(s, agentBusyUpdate(s, NOW + 10));
  const again = agentBusyUpdate(s, NOW + 20);
  assert.equal(again, null, "busy when already running should not produce a patch");
});

test("agentReadyUpdate is idempotent once an agent is already idle", () => {
  const s = baseSession({ agent: "CC", agentActivity: "idle", completedAt: NOW });
  assert.equal(agentReadyUpdate(s, false, NOW + 100), null);
});

test("agent confirmation lifecycle is conservative, reversible, and completes correctly", () => {
  const starting = baseSession({ agent: "CC", agentActivity: "starting", unread: true });
  assert.equal(agentWaitingConfirmationUpdate(starting, true), null);
  assert.equal(agentWaitingConfirmationUpdate({ ...starting, agentActivity: "idle" }, true), null);

  let s = { ...starting, agentActivity: "running", terminalProgress: { state: "indeterminate", updatedAt: NOW } };
  const waiting = agentWaitingConfirmationUpdate(s, false);
  assert.ok(waiting);
  s = apply(s, waiting);
  assert.equal(s.agentActivity, "waiting_confirmation");
  assert.equal(s.unread, true);
  assert.equal(s.completedAt, undefined);
  assert.equal(s.terminalProgress, undefined);
  assert.equal(agentWaitingConfirmationUpdate(s, false), null, "repeated waiting is idempotent");

  s = apply(s, agentBusyUpdate(s, NOW + 10));
  assert.equal(s.agentActivity, "running");
  assert.equal(s.unread, false);
  s = apply(s, agentWaitingConfirmationUpdate(s, true));
  assert.equal(s.unread, false, "an observed confirmation clears stale unread state");
  const ready = agentReadyUpdate(s, false, NOW + 20);
  assert.equal(ready?.refreshGit, true);
  s = apply(s, ready);
  assert.equal(s.agentActivity, "idle");
  assert.equal(s.completedAt, NOW + 20);
  assert.equal(s.unread, true);
});

test("command lifecycle: detected → finished marks done/failed and refreshes git", () => {
  let s = baseSession();

  // Command detected — runState running, lastCommand set.
  const cmd = commandDetectedUpdate(s, "npm test", NOW);
  assert.ok(cmd);
  s = apply(s, cmd);
  assert.equal(s.lastCommand, "npm test");
  assert.equal(s.runState, "running");
  assert.equal(s.startedAt, NOW);

  // Command finished with exit 0 — done, completedAt, git refresh requested.
  const finished = commandFinishedUpdate(s, 0, false, NOW + 500);
  assert.ok(finished);
  assert.equal(finished.refreshGit, true);
  s = apply(s, finished);
  assert.equal(s.runState, "done");
  assert.equal(s.lastExitCode, 0);
  assert.equal(s.completedAt, NOW + 500);
  assert.equal(s.unread, true, "inactive session gets unread on command finish");

  // Non-zero exit → failed.
  let s2 = apply(baseSession(), commandDetectedUpdate(baseSession(), "bad-cmd", NOW));
  s2 = apply(s2, commandFinishedUpdate(s2, 127, true, NOW + 100));
  assert.equal(s2.runState, "failed");
  assert.equal(s2.lastExitCode, 127);
  assert.equal(s2.unread, undefined, "active session does not get unread");
});

test("commandDetectedUpdate is skipped when an agent is active", () => {
  const s = apply(baseSession(), agentDetectedUpdate(baseSession(), "CC", NOW));
  const cmd = commandDetectedUpdate(s, "ls", NOW + 10);
  assert.equal(cmd, null, "commands should not be tracked when an agent owns the session");
});

test("commandFinishedUpdate on agent session only records exit code", () => {
  const s = apply(baseSession(), agentDetectedUpdate(baseSession(), "CC", NOW));
  const finished = commandFinishedUpdate(s, 0, true, NOW + 100);
  assert.ok(finished);
  assert.equal(finished.patch.runState, undefined, "agent session finish should not set runState");
  assert.equal(finished.patch.lastExitCode, 0);
});

test("terminalExitedUpdate clears agent and sets terminal done/failed", () => {
  // With agent active
  let s = apply(baseSession({ ptyId: 41 }), agentDetectedUpdate(baseSession({ ptyId: 41 }), "CC", NOW));
  s = apply(s, agentBusyUpdate(s, NOW + 10));
  const exited = terminalExitedUpdate(s, 0, false, NOW + 100);
  assert.ok(exited);
  s = apply(s, exited);
  assert.equal(s.agent, undefined);
  assert.equal(s.agentActivity, undefined);
  assert.equal(s.ptyId, undefined, "an exited PTY cannot remain a routable backend handle");
  assert.equal(s.runState, "done");
  assert.equal(s.lastCommand, undefined, "agent session exit clears lastCommand");

  // Without agent
  let s2 = apply(baseSession({ ptyId: 42 }), commandDetectedUpdate(baseSession({ ptyId: 42 }), "echo hi", NOW));
  const exited2 = terminalExitedUpdate(s2, 1, true, NOW + 100);
  s2 = apply(s2, exited2);
  assert.equal(s2.runState, "failed");
  assert.equal(s2.lastExitCode, 1);
  assert.equal(s2.ptyId, undefined);
  // Non-agent session keeps lastCommand for display.
  assert.equal(s2.lastCommand, "echo hi");
});

test("cwdChangedUpdate resets git state and requests git refresh", () => {
  const s = baseSession({ dir: "/old", branch: "main", gitState: "repo", lastCommand: "cd /new" });
  const update = cwdChangedUpdate(s, "/new");
  assert.ok(update);
  assert.equal(update.refreshGit, true);
  assert.equal(update.patch.dir, "/new");
  assert.equal(update.patch.branch, "");
  assert.equal(update.patch.gitState, "unknown");
  assert.equal(update.patch.changes, undefined);
  // cd command should be cleared.
  assert.equal(update.patch.lastCommand, undefined);
});

test("cwdChangedUpdate is a no-op when cwd hasn't changed", () => {
  const s = baseSession({ dir: "/home/user" });
  assert.equal(cwdChangedUpdate(s, "/home/user"), null);
});

test("shellTitleUpdate is suppressed for agent sessions and prompt-like titles", () => {
  const agentSession = apply(baseSession(), agentDetectedUpdate(baseSession(), "CC", NOW));
  assert.equal(shellTitleUpdate(agentSession, "My Title"), null);

  // Prompt-like titles (user@host path %) are rejected.
  assert.equal(shellTitleUpdate(baseSession(), "user@host /home %"), null);
  assert.equal(shellTitleUpdate(baseSession(), "root@server /var #"), null);

  // Normal title on non-agent session is accepted.
  const update = shellTitleUpdate(baseSession(), "server.log");
  assert.ok(update);
  assert.equal(update.patch.shellTitle, "server.log");
});

test("full lifecycle: plain shell → agent → exit → plain shell again", () => {
  let s = baseSession();

  // Start as plain shell, run a command.
  s = apply(s, commandDetectedUpdate(s, "ls", NOW));
  s = apply(s, commandFinishedUpdate(s, 0, true, NOW + 50));
  assert.equal(s.runState, "done");

  // Agent takes over.
  s = apply(s, agentDetectedUpdate(s, "CC", NOW + 100));
  assert.equal(s.agent, "CC");
  assert.equal(s.lastCommand, undefined, "agent detection clears lastCommand");

  // Agent busy then ready.
  s = apply(s, agentBusyUpdate(s, NOW + 200));
  s = apply(s, agentReadyUpdate(s, true, NOW + 300));
  assert.equal(s.agentActivity, "idle");

  // Agent exits.
  s = apply(s, agentExitedUpdate(s, 0, true, NOW + 400));
  assert.equal(s.agent, undefined);
  assert.equal(s.runState, "done");

  // Back to plain shell — run another command.
  s = apply(s, commandDetectedUpdate(s, "git status", NOW + 500));
  assert.equal(s.runState, "running");
  assert.equal(s.lastCommand, "git status");
});
