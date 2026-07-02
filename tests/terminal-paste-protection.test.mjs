import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Regression suite for the terminal paste guard.
//
// Root cause of the "SSH 会话无法粘贴" bug: the guard's default confirmer was
// `window.confirm`, which wry's WKWebView never renders (no JS-dialog UI
// delegate) — it synchronously returns a falsy value, so every multiline or
// >5KB paste was intercepted, "declined", and silently dropped app-wide.
// The confirmer is now injected (Tauri dialog plugin in TerminalView) and may
// be async; interception stays synchronous so the caller can preventDefault.

import {
  analyzeTerminalPaste,
  confirmProtectedTerminalPaste,
  TERMINAL_LARGE_PASTE_WARNING_LENGTH,
} from "../src/modules/terminal/lib/terminal-paste-protection.ts";
import { setLanguage } from "../src/modules/i18n/core.ts";

setLanguage("en");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── analyzeTerminalPaste ─────────────────────────────────────────────────

test("plain single-line paste is not intercepted", () => {
  assert.equal(analyzeTerminalPaste("echo hi"), null);
  assert.equal(analyzeTerminalPaste(""), null);
});

test("a single trailing newline still warns (it auto-submits) but counts one line", () => {
  const warning = analyzeTerminalPaste("echo hi\n");
  assert.ok(warning);
  assert.equal(warning.multiline, true);
  assert.equal(warning.lineCount, 1);
});

test("multiline and oversized pastes warn", () => {
  assert.equal(analyzeTerminalPaste("a\nb").lineCount, 2);
  const big = "x".repeat(TERMINAL_LARGE_PASTE_WARNING_LENGTH + 1);
  assert.equal(analyzeTerminalPaste(big).large, true);
});

// ── confirmProtectedTerminalPaste ────────────────────────────────────────

test("safe text: no interception, confirmer never invoked", () => {
  let confirmed = 0;
  let pasted = 0;
  const intercepted = confirmProtectedTerminalPaste(
    "echo hi",
    () => {
      confirmed += 1;
      return true;
    },
    () => {
      pasted += 1;
    },
  );
  assert.equal(intercepted, false);
  assert.equal(confirmed, 0);
  assert.equal(pasted, 0);
});

test("async confirm resolving true pastes the original text", async () => {
  let pasted = null;
  const intercepted = confirmProtectedTerminalPaste(
    "line1\nline2\n",
    () => Promise.resolve(true),
    (text) => {
      pasted = text;
    },
  );
  assert.equal(intercepted, true, "must preventDefault synchronously");
  assert.equal(pasted, null, "paste waits for the confirmation");
  await flush();
  assert.equal(pasted, "line1\nline2\n");
});

test("async confirm resolving false drops the paste", async () => {
  let pasted = 0;
  const intercepted = confirmProtectedTerminalPaste(
    "line1\nline2",
    () => Promise.resolve(false),
    () => {
      pasted += 1;
    },
  );
  assert.equal(intercepted, true);
  await flush();
  assert.equal(pasted, 0);
});

test("sync boolean confirmers still work", async () => {
  let pasted = 0;
  confirmProtectedTerminalPaste(
    "a\nb",
    () => true,
    () => {
      pasted += 1;
    },
  );
  await flush();
  assert.equal(pasted, 1);
});

test("a rejecting confirmer is treated as cancel, not an unhandled rejection", async () => {
  let pasted = 0;
  const intercepted = confirmProtectedTerminalPaste(
    "a\nb",
    () => Promise.reject(new Error("dialog unavailable")),
    () => {
      pasted += 1;
    },
  );
  assert.equal(intercepted, true);
  await flush();
  assert.equal(pasted, 0);
});

// ── structural guard ─────────────────────────────────────────────────────

test("no window.confirm/alert/prompt anywhere in src (silent no-ops in wry)", () => {
  const root = join(import.meta.dirname, "..", "src");
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx)$/.test(name)) {
        const content = readFileSync(path, "utf8");
        if (/window\.(confirm|alert|prompt)\(/.test(content)) offenders.push(path);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], "use @tauri-apps/plugin-dialog instead");
});
