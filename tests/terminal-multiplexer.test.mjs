import assert from "node:assert/strict";
import test from "node:test";
import { detectTerminalMultiplexer, sessionTerminalMultiplexer } from "../src/modules/session/terminal-multiplexer.ts";

test("detects multiplexers by program name, not substrings", () => {
  assert.equal(detectTerminalMultiplexer("herdr"), "herdr");
  assert.equal(detectTerminalMultiplexer("herdr session attach work"), "herdr");
  assert.equal(detectTerminalMultiplexer("TERM=xterm-256color exec tmux new -A -s main"), "tmux");
  assert.equal(detectTerminalMultiplexer("/opt/homebrew/bin/zellij attach"), "zellij");
  assert.equal(detectTerminalMultiplexer("env FOO=1 screen -r"), "screen");
  assert.equal(detectTerminalMultiplexer("vim tmux.conf"), null);
  assert.equal(detectTerminalMultiplexer("herdr-notes"), null);
  assert.equal(detectTerminalMultiplexer(""), null);
});

test("only a running, non-Agent session reports its multiplexer", () => {
  assert.equal(sessionTerminalMultiplexer({ runState: "running", lastCommand: "herdr" }), "herdr");
  assert.equal(sessionTerminalMultiplexer({ runState: "done", lastCommand: "herdr" }), null);
  assert.equal(sessionTerminalMultiplexer({ runState: "running", lastCommand: "herdr", agent: "claude" }), null);
});
