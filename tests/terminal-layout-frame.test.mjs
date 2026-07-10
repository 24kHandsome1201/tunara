import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TERMINAL_LAYOUT_FRAME_TIMEOUT_MS,
  waitForTerminalLayoutFrame,
} from "../src/modules/terminal/lib/terminal-layout-frame.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("terminal layout continues on the next animation frame", async () => {
  let scheduled;
  let cancelled;
  const result = await waitForTerminalLayoutFrame({
    requestFrame: (callback) => { callback(0); return 1; },
    scheduleTimeout: (callback, timeoutMs) => {
      scheduled = { callback, timeoutMs };
      return 42;
    },
    cancelTimeout: (handle) => { cancelled = handle; },
  });

  assert.equal(result, "frame");
  assert.equal(scheduled.timeoutMs, TERMINAL_LAYOUT_FRAME_TIMEOUT_MS);
  assert.equal(cancelled, 42);
});

test("terminal layout falls back when a background WebView never paints", async () => {
  let fireTimeout;
  let cancelledFrame;
  const waiting = waitForTerminalLayoutFrame({
    requestFrame: () => 1,
    cancelFrame: (handle) => { cancelledFrame = handle; },
    scheduleTimeout: (callback) => {
      fireTimeout = callback;
      return 42;
    },
  });

  fireTimeout();
  assert.equal(await waiting, "timeout");
  assert.equal(cancelledFrame, 1);
});

test("TerminalView uses the bounded layout wait before opening a PTY", () => {
  const terminalView = readFileSync(resolve(root, "src/ui/TerminalView.tsx"), "utf8");
  assert.match(terminalView, /await waitForTerminalLayoutFrame\(\)/);
  assert.doesNotMatch(terminalView, /await new Promise<void>\(\(r\) => requestAnimationFrame/);
});
