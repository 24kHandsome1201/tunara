import assert from "node:assert/strict";
import test from "node:test";

// The command text helpers are pure. The other two exports
// (extractCommandFromBuffer / getTerminalTailText) iterate a live xterm.js
// Terminal buffer and cannot run headless, so they are not covered here.
import {
  extractCommandFromBuffer,
  extractCommandFromOsc,
  resolveTerminalCommandText,
} from "../src/modules/terminal/lib/terminal-buffer-read.ts";

function terminalBuffer(lines, cursorY = lines.length - 1) {
  return {
    buffer: {
      active: {
        baseY: 0,
        cursorY,
        getLine(row) {
          const line = lines[row];
          if (!line) return undefined;
          return {
            isWrapped: Boolean(line.wrapped),
            translateToString(_trimRight, start = 0) {
              return line.text.slice(start).replace(/\s+$/, "");
            },
          };
        },
      },
    },
  };
}

test("extractCommandFromBuffer excludes the visible prompt before OSC 133 B", () => {
  const term = terminalBuffer([{ text: "root@host:/tmp# pi --session abc" }]);
  assert.equal(extractCommandFromBuffer(term, { row: 0, column: 16 }), "pi --session abc");
});

test("extractCommandFromBuffer rejoins terminal soft wraps without inserting spaces", () => {
  const term = terminalBuffer([
    { text: "root@host:/tmp# PI_CODING_AGENT_DIR=/tmp/agent ./pi --sess" },
    { text: "ion-id 99999999-9999-4999-8999-999999999999", wrapped: true },
  ]);
  assert.equal(
    extractCommandFromBuffer(term, { row: 0, column: 16 }),
    "PI_CODING_AGENT_DIR=/tmp/agent ./pi --session-id 99999999-9999-4999-8999-999999999999",
  );
});

test("extractCommandFromOsc decodes a plain C;-prefixed command", () => {
  assert.equal(extractCommandFromOsc("C;git status"), "git status");
});

test("extractCommandFromOsc percent-decodes the payload", () => {
  assert.equal(extractCommandFromOsc("C;echo%20hello%20world"), "echo hello world");
  assert.equal(extractCommandFromOsc("C;cd%20%2Ftmp"), "cd /tmp");
});

test("extractCommandFromOsc trims surrounding whitespace after decoding", () => {
  assert.equal(extractCommandFromOsc("C;  spaced  "), "spaced");
});

test("extractCommandFromOsc returns empty string when the C; sentinel is missing", () => {
  assert.equal(extractCommandFromOsc("git status"), "");
  assert.equal(extractCommandFromOsc("D;0"), "");
  assert.equal(extractCommandFromOsc(""), "");
});

test("extractCommandFromOsc swallows malformed percent-encoding and returns empty string", () => {
  // A lone '%' is invalid percent-encoding; decodeURIComponent throws and the
  // function falls back to "".
  assert.equal(extractCommandFromOsc("C;bad%"), "");
  assert.equal(extractCommandFromOsc("C;100%done"), "");
});

test("extractCommandFromOsc handles an empty command after the sentinel", () => {
  assert.equal(extractCommandFromOsc("C;"), "");
});

test("resolveTerminalCommandText prefers an OSC payload when the shell provides one", () => {
  assert.equal(
    resolveTerminalCommandText("C;git%20status", "echo stale", "root@host:~# git status"),
    "git status",
  );
});

test("resolveTerminalCommandText uses submitted input for Bash PS0 markers", () => {
  assert.equal(
    resolveTerminalCommandText("C", "  aider --no-git  ", "root@host:~# aider --no-git"),
    "aider --no-git",
  );
});

test("resolveTerminalCommandText falls back to the terminal buffer without submitted input", () => {
  assert.equal(resolveTerminalCommandText("C", null, "git status"), "git status");
});
