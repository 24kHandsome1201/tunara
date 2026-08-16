import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RETAINED_TERMINAL_BLOCKS,
  findCommandBlockAtRow,
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

test("findCommandBlockAtRow resolves the block covering a buffer row via live markers", () => {
  const spanning = {
    ...block("span", 10),
    endRow: 14,
    endMarker: marker(14),
  };
  const blocks = [block("early", 2), spanning, block("late", 20)];

  assert.equal(findCommandBlockAtRow(blocks, 10)?.id, "span", "command row itself belongs to the block");
  assert.equal(findCommandBlockAtRow(blocks, 14)?.id, "span");
  assert.equal(findCommandBlockAtRow(blocks, 2)?.id, "early");
  assert.equal(findCommandBlockAtRow(blocks, 15), null, "gap rows resolve to no block");
  assert.equal(findCommandBlockAtRow([block("gone", 5, true)], 5), null, "disposed markers drop out");
});

test("findCommandBlockAtRow prefers the most recent block when ranges overlap", () => {
  const first = { ...block("first", 4), endRow: 8, endMarker: marker(8) };
  const second = { ...block("second", 6), endRow: 9, endMarker: marker(9) };
  assert.equal(findCommandBlockAtRow([first, second], 7)?.id, "second");
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
