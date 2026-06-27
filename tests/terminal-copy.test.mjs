import assert from "node:assert/strict";
import test from "node:test";

import { handleCopyKeyEvent } from "../src/modules/terminal/lib/terminal-copy.ts";

function makeTerm(selection) {
  return { getSelection: () => selection };
}

function makeEvent(overrides = {}) {
  return {
    type: "keydown",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    key: "c",
    ...overrides,
  };
}

function stubClipboard() {
  const writes = [];
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (t) => { writes.push(t); } } },
    configurable: true,
    writable: true,
  });
  return {
    writes,
    restore: () => {
      if (prev) Object.defineProperty(globalThis, "navigator", prev);
      else delete globalThis.navigator;
    },
  };
}

test("⌘C with a selection copies and short-circuits the handler chain", () => {
  const cb = stubClipboard();
  try {
    const result = handleCopyKeyEvent(makeTerm("hello world"), makeEvent());
    assert.equal(result, false, "returns false so xterm/search/blocks skip the key");
    assert.deepEqual(cb.writes, ["hello world"]);
  } finally {
    cb.restore();
  }
});

test("⌘C with no selection passes through (lets SIGINT fire)", () => {
  const cb = stubClipboard();
  try {
    const result = handleCopyKeyEvent(makeTerm(""), makeEvent());
    assert.equal(result, true, "returns true so the chain continues / terminal interrupts");
    assert.deepEqual(cb.writes, [], "nothing written to clipboard");
  } finally {
    cb.restore();
  }
});

test("non-⌘C keys always pass through unchanged", () => {
  const cb = stubClipboard();
  try {
    assert.equal(handleCopyKeyEvent(makeTerm("sel"), makeEvent({ key: "v" })), true);
    assert.equal(handleCopyKeyEvent(makeTerm("sel"), makeEvent({ metaKey: false, ctrlKey: true })), true);
    assert.equal(handleCopyKeyEvent(makeTerm("sel"), makeEvent({ key: "c", metaKey: true, altKey: true })), true);
    assert.deepEqual(cb.writes, [], "no copy on non-⌘C keys");
  } finally {
    cb.restore();
  }
});

test("keyup events are ignored (only keydown triggers copy)", () => {
  const cb = stubClipboard();
  try {
    const result = handleCopyKeyEvent(makeTerm("sel"), makeEvent({ type: "keyup" }));
    assert.equal(result, true);
    assert.deepEqual(cb.writes, []);
  } finally {
    cb.restore();
  }
});
