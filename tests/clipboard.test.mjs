import assert from "node:assert/strict";
import test from "node:test";

import { copyText, readClipboardText } from "../src/ui/lib/clipboard.ts";

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

test("readClipboardText uses the web clipboard API outside Tauri", async () => {
  const reads = [];
  await withNavigator({ clipboard: { readText: async () => { reads.push("web"); return "from-web"; } } }, async () => {
    assert.equal(await readClipboardText(), "from-web");
    assert.deepEqual(reads, ["web"]);
  });
});

test("readClipboardText throws when the web clipboard API is unavailable outside Tauri", async () => {
  await withNavigator({}, async () => {
    await assert.rejects(readClipboardText(), /clipboard unavailable/);
  });
});

test("readClipboardText does not fall back to the web clipboard API in Tauri", async () => {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previousWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: {} };
  let webReads = 0;
  try {
    await withNavigator({
      clipboard: { readText: async () => { webReads += 1; return "from-web"; } },
    }, async () => {
      await assert.rejects(readClipboardText());
      assert.equal(webReads, 0);
    });
  } finally {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }
});
