import assert from "node:assert/strict";
import test from "node:test";

// Only extractCommandFromOsc is pure (string -> string). The other two exports
// (extractCommandFromBuffer / getTerminalTailText) iterate a live xterm.js
// Terminal buffer and cannot run headless, so they are not covered here.
import { extractCommandFromOsc } from "../src/modules/terminal/lib/terminal-buffer-read.ts";

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
