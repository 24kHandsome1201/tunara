import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDroppedTerminalPaths,
  MAX_DROPPED_TERMINAL_PATHS,
  shellQuotePath,
} from "../src/modules/terminal/lib/terminal-drop-paths.ts";

test("shellQuotePath leaves safe tokens unquoted and POSIX-quotes the rest", () => {
  assert.equal(shellQuotePath("/tmp/notes.txt"), "/tmp/notes.txt");
  assert.equal(shellQuotePath("/tmp/my file.txt"), "'/tmp/my file.txt'");
  assert.equal(shellQuotePath("/tmp/it's.txt"), "'/tmp/it'\\''s.txt'");
  assert.equal(shellQuotePath(""), "''");
});

test("formatDroppedTerminalPaths joins quoted paths with a trailing space and no newline", () => {
  assert.equal(formatDroppedTerminalPaths([]), null);
  assert.equal(formatDroppedTerminalPaths(["", "  ", "\u0000"]), null);
  assert.equal(
    formatDroppedTerminalPaths(["/tmp/a.txt", "/tmp/b c.txt"]),
    "/tmp/a.txt '/tmp/b c.txt' ",
  );
  assert.equal(formatDroppedTerminalPaths(["/tmp/a.txt"]).includes("\n"), false);
});

test("formatDroppedTerminalPaths caps how many dropped paths are inserted", () => {
  const paths = Array.from({ length: MAX_DROPPED_TERMINAL_PATHS + 8 }, (_, index) => `/tmp/f${index}`);
  const inserted = formatDroppedTerminalPaths(paths);
  assert.ok(inserted);
  assert.equal(inserted.trim().split(" ").length, MAX_DROPPED_TERMINAL_PATHS);
});
