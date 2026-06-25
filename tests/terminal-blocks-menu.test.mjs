import assert from "node:assert/strict";
import test from "node:test";

import { buildBlockContextMenuItems } from "../src/modules/terminal/lib/terminal-blocks-menu.ts";

function makeBlock(overrides = {}) {
  return {
    id: "block-1",
    command: "ls -la",
    startRow: 0,
    endRow: 5,
    startedAt: 1000,
    ...overrides,
  };
}

function makeHandlers() {
  const calls = {
    onCopyCommand: [],
    onCopyOutput: [],
    onCopyCommandAndOutput: [],
    onFilterBlock: [],
    onReveal: [],
    onToggle: [],
  };
  return {
    calls,
    handlers: {
      onCopyCommand: (id) => { calls.onCopyCommand.push(id); },
      onCopyOutput: (id) => { calls.onCopyOutput.push(id); },
      onCopyCommandAndOutput: (id) => { calls.onCopyCommandAndOutput.push(id); },
      onFilterBlock: (block) => { calls.onFilterBlock.push(block); },
      onReveal: (id) => { calls.onReveal.push(id); },
      onToggle: (id) => { calls.onToggle.push(id); },
    },
  };
}

function entries(items) {
  return items.filter((item) => item !== null);
}

test("buildBlockContextMenuItems wires each entry to the matching handler with the block id", () => {
  const block = makeBlock({ id: "abc" });
  const { calls, handlers } = makeHandlers();
  const items = entries(buildBlockContextMenuItems(block, true, false, handlers));

  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  byId["block:copy-command"].action();
  assert.deepEqual(calls.onCopyCommand, ["abc"]);

  byId["block:copy-output"].action();
  assert.deepEqual(calls.onCopyOutput, ["abc"]);

  byId["block:copy-both"].action();
  assert.deepEqual(calls.onCopyCommandAndOutput, ["abc"]);

  byId["block:filter-output"].action();
  assert.deepEqual(calls.onFilterBlock, [block]);

  byId["block:reveal"].action();
  assert.deepEqual(calls.onReveal, ["abc"]);

  byId["block:toggle"].action();
  assert.deepEqual(calls.onToggle, ["abc"]);
});

test("buildBlockContextMenuItems disables output-dependent entries while the command is still running", () => {
  const { handlers } = makeHandlers();
  const items = entries(buildBlockContextMenuItems(makeBlock(), false, false, handlers));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId["block:copy-command"].disabled, undefined, "复制命令 should stay enabled even while running");
  assert.equal(byId["block:copy-output"].disabled, true);
  assert.equal(byId["block:copy-both"].disabled, true);
  assert.equal(byId["block:filter-output"].disabled, true);
  assert.equal(byId["block:reveal"].disabled, undefined);
  assert.equal(byId["block:toggle"].disabled, undefined);
});

test("buildBlockContextMenuItems enables output entries once the command has completed", () => {
  const { handlers } = makeHandlers();
  const items = entries(buildBlockContextMenuItems(makeBlock(), true, false, handlers));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.notEqual(byId["block:copy-output"].disabled, true);
  assert.notEqual(byId["block:copy-both"].disabled, true);
  assert.notEqual(byId["block:filter-output"].disabled, true);
});

test("buildBlockContextMenuItems toggle label reflects the collapsed state", () => {
  const { handlers } = makeHandlers();
  const collapsedItems = entries(buildBlockContextMenuItems(makeBlock(), true, true, handlers));
  const expandedItems = entries(buildBlockContextMenuItems(makeBlock(), true, false, handlers));

  const collapsedToggle = collapsedItems.find((item) => item.id === "block:toggle");
  const expandedToggle = expandedItems.find((item) => item.id === "block:toggle");

  assert.equal(collapsedToggle.label, "展开输出");
  assert.equal(expandedToggle.label, "折叠输出");
});

test("buildBlockContextMenuItems keeps copy and navigation groups separated by a divider", () => {
  const { handlers } = makeHandlers();
  const items = buildBlockContextMenuItems(makeBlock(), true, false, handlers);

  const dividerIndex = items.findIndex((item) => item === null);
  assert.ok(dividerIndex > 0, "expected a divider somewhere after the copy group");

  const beforeDivider = items.slice(0, dividerIndex).filter((item) => item !== null).map((item) => item.id);
  const afterDivider = items.slice(dividerIndex + 1).filter((item) => item !== null).map((item) => item.id);

  assert.deepEqual(beforeDivider, ["block:copy-command", "block:copy-output", "block:copy-both", "block:filter-output"]);
  assert.deepEqual(afterDivider, ["block:reveal", "block:toggle"]);
});

test("buildBlockContextMenuItems uses the icon catalog so ContextMenu renders the expected glyphs", () => {
  const { handlers } = makeHandlers();
  const items = entries(buildBlockContextMenuItems(makeBlock(), true, false, handlers));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId["block:copy-command"].icon, "copy");
  assert.equal(byId["block:copy-output"].icon, "copy");
  assert.equal(byId["block:copy-both"].icon, "copy");
  assert.equal(byId["block:filter-output"].icon, "search");
  assert.equal(byId["block:reveal"].icon, "terminal");
  assert.equal(byId["block:toggle"].icon, "terminal");
});
