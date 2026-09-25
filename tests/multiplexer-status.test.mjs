import assert from "node:assert/strict";
import test from "node:test";
import { sameMultiplexerSummary, statusMultiplexer, summarizeMultiplexerPanes } from "../src/modules/session/multiplexer-status.ts";

test("HerdR summary counts agent panes only and keeps the focused cwd", () => {
  const summary = summarizeMultiplexerPanes([
    { paneId: "a", focused: false, agent: "claude", agentStatus: "blocked", cwd: "/a" },
    { paneId: "b", focused: true, agent: null, agentStatus: "blocked", cwd: "/b" },
    { paneId: "c", focused: false, agent: "codex", agentStatus: "working", cwd: null },
    { paneId: "d", focused: false, agent: "codex", agentStatus: "done", cwd: null },
    { paneId: "e", focused: false, agent: "pi", agentStatus: "unknown", cwd: null },
  ]);
  assert.deepEqual(summary, { blocked: 1, working: 1, running: 0, done: 1, focusedCwd: "/b" });
  assert.equal(sameMultiplexerSummary(summary, { ...summary }), true);
  assert.equal(sameMultiplexerSummary(summary, { ...summary, blocked: 2 }), false);
  assert.equal(sameMultiplexerSummary(null, null), true);
  assert.equal(sameMultiplexerSummary(null, undefined), true);
});

test("tmux/zellij foreground agents count as running, never blocked", () => {
  const summary = summarizeMultiplexerPanes([
    { paneId: "%1", sessionId: "$0", windowId: "@0", focused: false, agent: "claude", agentStatus: "running", cwd: "/repo" },
    { paneId: "%2", sessionId: "$0", windowId: "@0", focused: true, agent: null, agentStatus: "unknown", cwd: "/repo/sub" },
    { paneId: "%3", sessionId: "$0", windowId: "@1", focused: false, agent: "codex", agentStatus: "running", cwd: null },
  ]);
  assert.deepEqual(summary, { blocked: 0, working: 0, running: 2, done: 0, focusedCwd: "/repo/sub" });
  assert.equal(sameMultiplexerSummary(summary, { ...summary, running: 1 }), false);
});

test("only HerdR, tmux and Zellij have status adapters", () => {
  assert.equal(statusMultiplexer("herdr"), "herdr");
  assert.equal(statusMultiplexer("tmux"), "tmux");
  assert.equal(statusMultiplexer("zellij"), "zellij");
  assert.equal(statusMultiplexer("screen"), null);
  assert.equal(statusMultiplexer(null), null);
});
