import assert from "node:assert/strict";
import test from "node:test";

import { blockStatusLabel, buildBlockContextMenuItems } from "../src/modules/terminal/lib/terminal-blocks-menu.ts";
import { setLanguage } from "../src/modules/i18n/core.ts";

setLanguage("zh-CN");

const NOW = 10_000_000;

function makeBlock(overrides = {}) {
  return {
    id: "block-1",
    command: "ls -la",
    startRow: 0,
    endRow: 5,
    startedAt: NOW - 5_000,
    completedAt: NOW,
    exitCode: 0,
    ...overrides,
  };
}

function makeHandlers() {
  const calls = {
    onRerun: [],
    onCopyCommand: [],
    onCopyOutput: [],
    onCopyCommandAndOutput: [],
    onReveal: [],
  };
  return {
    calls,
    handlers: {
      onRerun: (command) => { calls.onRerun.push(command); },
      onCopyCommand: (id) => { calls.onCopyCommand.push(id); },
      onCopyOutput: (id) => { calls.onCopyOutput.push(id); },
      onCopyCommandAndOutput: (id) => { calls.onCopyCommandAndOutput.push(id); },
      onReveal: (id) => { calls.onReveal.push(id); },
    },
  };
}

function actionEntries(items) {
  return items.filter((item) => item !== null && !("type" in item));
}

test("buildBlockContextMenuItems wires each entry to the matching handler", () => {
  const block = makeBlock({ id: "abc" });
  const { calls, handlers } = makeHandlers();
  const items = actionEntries(buildBlockContextMenuItems(block, handlers, NOW));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  byId["block:rerun"].action();
  assert.deepEqual(calls.onRerun, ["ls -la"], "rerun passes the command text, not the id");

  byId["block:copy-command"].action();
  assert.deepEqual(calls.onCopyCommand, ["abc"]);

  byId["block:copy-output"].action();
  assert.deepEqual(calls.onCopyOutput, ["abc"]);

  byId["block:copy-both"].action();
  assert.deepEqual(calls.onCopyCommandAndOutput, ["abc"]);

  byId["block:reveal"].action();
  assert.deepEqual(calls.onReveal, ["abc"]);
});

test("buildBlockContextMenuItems disables output-dependent entries while the command is still running", () => {
  const { handlers } = makeHandlers();
  const running = makeBlock({ completedAt: undefined, exitCode: undefined });
  const items = actionEntries(buildBlockContextMenuItems(running, handlers, NOW));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId["block:rerun"].disabled, false, "回填命令 stays enabled while running — it never auto-submits");
  assert.equal(byId["block:copy-command"].disabled, undefined);
  assert.equal(byId["block:copy-output"].disabled, true);
  assert.equal(byId["block:copy-both"].disabled, true);
  assert.equal(byId["block:reveal"].disabled, undefined);
});

test("buildBlockContextMenuItems enables output entries once the command has completed", () => {
  const { handlers } = makeHandlers();
  const items = actionEntries(buildBlockContextMenuItems(makeBlock(), handlers, NOW));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.notEqual(byId["block:copy-output"].disabled, true);
  assert.notEqual(byId["block:copy-both"].disabled, true);
});

test("buildBlockContextMenuItems leads with a status heading showing exit state and duration", () => {
  const { handlers } = makeHandlers();

  const done = buildBlockContextMenuItems(makeBlock(), handlers, NOW)[0];
  assert.equal(done.type, "heading");
  assert.equal(done.label, "成功 · 耗时 5s");

  const failed = buildBlockContextMenuItems(
    makeBlock({ exitCode: 1, startedAt: NOW - 134_000 }),
    handlers,
    NOW,
  )[0];
  assert.equal(failed.label, "失败 (exit 1) · 耗时 2m 14s");

  const running = buildBlockContextMenuItems(
    makeBlock({ completedAt: undefined, exitCode: undefined, startedAt: NOW - 3_000 }),
    handlers,
    NOW,
  )[0];
  assert.equal(running.label, "运行中 · 3s");
});

test("blockStatusLabel keeps sub-second runs readable instead of showing 0s", () => {
  assert.equal(
    blockStatusLabel(makeBlock({ startedAt: NOW - 200 }), NOW),
    "成功 · 耗时 <1s",
  );
});

test("buildBlockContextMenuItems separates rerun, copy, and navigation groups", () => {
  const { handlers } = makeHandlers();
  const items = buildBlockContextMenuItems(makeBlock(), handlers, NOW);

  const groups = [];
  let current = [];
  for (const item of items) {
    if (item === null) {
      groups.push(current);
      current = [];
    } else if (!("type" in item)) {
      current.push(item.id);
    }
  }
  groups.push(current);

  assert.deepEqual(groups, [
    ["block:rerun"],
    ["block:copy-command", "block:copy-output", "block:copy-both"],
    ["block:reveal"],
  ]);
});

test("buildBlockContextMenuItems uses the icon catalog so ContextMenu renders the expected glyphs", () => {
  const { handlers } = makeHandlers();
  const items = actionEntries(buildBlockContextMenuItems(makeBlock(), handlers, NOW));
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId["block:rerun"].icon, "terminal");
  assert.equal(byId["block:copy-command"].icon, "copy");
  assert.equal(byId["block:copy-output"].icon, "copy");
  assert.equal(byId["block:copy-both"].icon, "copy");
  assert.equal(byId["block:reveal"].icon, "terminal");
});
