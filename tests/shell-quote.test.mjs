import assert from "node:assert/strict";
import test from "node:test";

import { formatDroppedTerminalPaths, formatExplorerTerminalPath, shellQuoteToken } from "../src/modules/terminal/lib/shell-quote.ts";

test("safe path tokens stay unquoted", () => {
  assert.equal(shellQuoteToken("/tmp/app.ts"), "/tmp/app.ts");
  assert.equal(shellQuoteToken("C:/Users/me/file"), "C:/Users/me/file");
});

test("dropped paths are quoted and prefixed with a space", () => {
  assert.equal(formatDroppedTerminalPaths(["/tmp/My File.ts"]), " '/tmp/My File.ts'");
  assert.equal(
    formatDroppedTerminalPaths(["/tmp/a.ts", "/tmp/b.ts"]),
    " /tmp/a.ts /tmp/b.ts",
  );
});

test("dropped paths ignore blanks, control characters, and the insertion cap", () => {
  assert.equal(formatDroppedTerminalPaths(["", "  ", "/tmp/ok.ts"]), " /tmp/ok.ts");
  assert.equal(formatDroppedTerminalPaths(["/tmp/bad\nname"]), null);
  const many = Array.from({ length: 20 }, (_, index) => `/tmp/f${index}`);
  const formatted = formatDroppedTerminalPaths(many);
  assert.equal(formatted?.trim().split(" ").length, 16);
});

test("explorer paths are inserted verbatim as one quoted shell word", () => {
  assert.equal(formatExplorerTerminalPath("/tmp/app.ts", false), "'/tmp/app.ts'");
  assert.equal(formatExplorerTerminalPath("/tmp/My Folder", true), "cd -- '/tmp/My Folder'");
  assert.equal(formatExplorerTerminalPath("/tmp/O'Brien \\ draft ", false), "'/tmp/O'\\''Brien '\\\\' draft '");
  assert.equal(formatExplorerTerminalPath("/tmp/$(example); report", false), "'/tmp/$(example); report'");
});

test("explorer paths reject relative paths and terminal controls", () => {
  for (const path of ["", "~/app.ts", "/tmp/bad\nname", "/tmp/bad\rname", "/tmp/\x1b[200~", "/tmp/tab\tname", "/tmp/\x9b"]) {
    assert.equal(formatExplorerTerminalPath(path, false), null, JSON.stringify(path));
  }
});
