import assert from "node:assert/strict";
import test from "node:test";

import { copyText } from "../src/ui/lib/clipboard.ts";

function withNavigator(value, fn) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  return Promise.resolve(fn()).finally(() => {
    if (prev) Object.defineProperty(globalThis, "navigator", prev);
    else delete globalThis.navigator;
  });
}

test("copyText writes through navigator.clipboard and returns true", async () => {
  const writes = [];
  await withNavigator({ clipboard: { writeText: async (t) => { writes.push(t); } } }, async () => {
    assert.equal(await copyText("hello"), true);
    assert.deepEqual(writes, ["hello"]);
  });
});

test("copyText returns false (never throws) when the write rejects", async () => {
  await withNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } }, async () => {
    assert.equal(await copyText("x"), false);
  });
});

test("copyText returns false when the Clipboard API is unavailable", async () => {
  await withNavigator({}, async () => {
    assert.equal(await copyText("x"), false);
  });
});
