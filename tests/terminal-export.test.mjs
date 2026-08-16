import assert from "node:assert/strict";
import test from "node:test";

import {
  clipTerminalExportText,
  collectTerminalBufferText,
  MAX_TERMINAL_EXPORT_BYTES,
  MAX_TERMINAL_EXPORT_LINES,
} from "../src/modules/terminal/lib/terminal-export.ts";

test("clipTerminalExportText keeps the tail within the line and byte ceilings", () => {
  assert.deepEqual(clipTerminalExportText(""), { text: "", truncated: false, lineCount: 0 });
  assert.deepEqual(clipTerminalExportText("ok\u0000line"), {
    text: "okline",
    truncated: false,
    lineCount: 1,
  });

  const many = Array.from({ length: MAX_TERMINAL_EXPORT_LINES + 5 }, (_, index) => `line-${index}`);
  const clipped = clipTerminalExportText(many.join("\n"));
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.lineCount, MAX_TERMINAL_EXPORT_LINES);
  assert.equal(clipped.text.startsWith("line-5\n"), true);
  assert.equal(clipped.text.endsWith(`line-${MAX_TERMINAL_EXPORT_LINES + 4}`), true);

  const oversized = `${"a".repeat(MAX_TERMINAL_EXPORT_BYTES)}\nkept`;
  const byBytes = clipTerminalExportText(oversized);
  assert.equal(byBytes.truncated, true);
  assert.equal(byBytes.text, "kept");
  assert.ok(byBytes.text.length <= MAX_TERMINAL_EXPORT_BYTES);
});

test("collectTerminalBufferText reads the newest rows and drops trailing blanks", () => {
  const rows = ["keep", "mid", "", "tail", "", ""];
  const buffer = {
    length: rows.length,
    getLine(row) {
      return { translateToString: () => rows[row] };
    },
  };
  assert.deepEqual(collectTerminalBufferText(buffer), {
    text: "keep\nmid\n\ntail",
    truncated: false,
    lineCount: 4,
  });
});
