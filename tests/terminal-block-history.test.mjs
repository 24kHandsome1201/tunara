import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RETAINED_TERMINAL_BLOCKS,
  retainNavigableTerminalBlocks,
} from "../src/modules/terminal/lib/terminal-blocks.ts";

function marker(line, isDisposed = false) {
  return { line, isDisposed, dispose() {} };
}

function block(id, line, disposed = false) {
  const rowMarker = marker(line, disposed);
  return {
    id,
    command: `echo ${id}`,
    startRow: line,
    endRow: line,
    startMarker: rowMarker,
    endMarker: rowMarker,
    startedAt: line,
  };
}

test("command block history follows live scrollback markers", () => {
  const retained = retainNavigableTerminalBlocks([
    block("trimmed", 0, true),
    block("visible-a", 10),
    block("visible-b", 20),
  ]);
  assert.deepEqual(retained.map((item) => item.id), ["visible-a", "visible-b"]);
});

test("command block history uses a generous bounded limit", () => {
  assert.equal(MAX_RETAINED_TERMINAL_BLOCKS, 240);
  const retained = retainNavigableTerminalBlocks([
    block("a", 1),
    block("b", 2),
    block("c", 3),
  ], 2);
  assert.deepEqual(retained.map((item) => item.id), ["b", "c"]);
  assert.deepEqual(retainNavigableTerminalBlocks([block("a", 1)], 0), []);
});
