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
  pasteWithCapturedBracketedMode,
  registerTerminalPasteProtection,
  requestProtectedTerminalPaste,
  terminalPasteWarningMessage,
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

test("single-line C0/C1, ESC, NUL, and BEL are risky and previewed only as escapes", () => {
  for (const character of ["\u0000", "\u0007", "\u001b", "\u0085"]) {
    const warning = analyzeTerminalPaste(`echo${character}ok`);
    assert.equal(warning.controlCharacters, true);
    assert.doesNotMatch(warning.escapedPreview, /[\u0000-\u001f\u007f-\u009f]/);
    const message = terminalPasteWarningMessage(warning);
    assert.doesNotMatch(message, new RegExp(character));
    assert.match(message, /\\(?:e|x[0-9a-f]{2})/);
  }
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

test("confirmed paste preserves bracketed mode captured before a native dialog focus transition", () => {
  const pasted = [];
  const input = [];
  const term = {
    modes: { bracketedPasteMode: false },
    input: (text, wasUserInput) => input.push([text, wasUserInput]),
    paste: (text) => pasted.push(text),
  };
  pasteWithCapturedBracketedMode(term, "line1\nline2", true);
  assert.deepEqual(pasted, []);
  assert.deepEqual(input, [["\u001b[200~line1\rline2\u001b[201~", true]]);
});

test("captured bracketed paste normalizes LF and CRLF exactly like xterm", () => {
  const pasted = [];
  const input = [];
  const term = {
    input: (text) => input.push(text),
    paste: (text) => pasted.push(text),
  };
  pasteWithCapturedBracketedMode(term, "one\r\ntwo\nthree\rfour", true);
  assert.deepEqual(pasted, []);
  assert.deepEqual(input, ["\u001b[200~one\rtwo\rthree\rfour\u001b[201~"]);
});

test("ordinary paste does not wait when bracketed mode was not active before confirmation", () => {
  const pasted = [];
  pasteWithCapturedBracketedMode({
    modes: { bracketedPasteMode: false },
    paste: (text) => pasted.push(text),
  }, "echo one\necho two", false);
  assert.deepEqual(pasted, ["echo one\necho two"]);
});

test("confirmed paste is ignored after its terminal element is detached", () => {
  const pasted = [];
  pasteWithCapturedBracketedMode({
    element: { isConnected: false },
    input: (text) => pasted.push(text),
    paste: (text) => pasted.push(text),
  }, "line1\nline2", true);
  assert.deepEqual(pasted, []);
});

test("shared protected-paste entry captures bracketed mode before the async confirmer", async () => {
  const pasted = [];
  let resolveConfirmation;
  const term = {
    modes: { bracketedPasteMode: true },
    input: (text) => pasted.push(text),
    paste: (text) => pasted.push(text),
  };
  const intercepted = requestProtectedTerminalPaste(term, "line1\nline2", () =>
    new Promise((resolve) => { resolveConfirmation = resolve; }), () => true);
  assert.equal(intercepted, true);

  term.modes.bracketedPasteMode = false;
  resolveConfirmation(true);
  await flush();
  assert.deepEqual(pasted, ["\u001b[200~line1\rline2\u001b[201~"]);
});

test("shared protected-paste entry ignores confirmation after its target is superseded", async () => {
  const pasted = [];
  let current = true;
  let resolveConfirmation;
  const term = {
    modes: { bracketedPasteMode: true },
    input: (text) => pasted.push(text),
    paste: (text) => pasted.push(text),
  };
  requestProtectedTerminalPaste(
    term,
    "line1\nline2",
    () => new Promise((resolve) => { resolveConfirmation = resolve; }),
    () => current,
  );

  current = false;
  resolveConfirmation(true);
  await flush();
  assert.deepEqual(pasted, []);
});

test("registered paste protection invalidates an in-flight confirmation on dispose", async () => {
  const pasted = [];
  let resolveConfirmation;
  let pasteListener;
  const element = {
    isConnected: true,
    addEventListener: (_type, listener) => { pasteListener = listener; },
    removeEventListener() {},
  };
  const registration = registerTerminalPasteProtection({
    element,
    modes: { bracketedPasteMode: true },
    input: (text) => pasted.push(text),
    paste: (text) => pasted.push(text),
  }, () => new Promise((resolve) => { resolveConfirmation = resolve; }));
  pasteListener({
    clipboardData: { getData: () => "line1\nline2" },
    preventDefault() {},
    stopPropagation() {},
  });

  registration.dispose();
  resolveConfirmation(true);
  await flush();
  assert.deepEqual(pasted, []);
});

test("registered paste protection rejects safe text delivered to a stale target", () => {
  let pasteListener;
  const element = {
    isConnected: true,
    addEventListener: (_type, listener) => { pasteListener = listener; },
    removeEventListener() {},
  };
  registerTerminalPasteProtection({
    element,
    paste() {},
  }, () => true, () => () => false);
  let prevented = 0;
  let stopped = 0;
  pasteListener({
    clipboardData: { getData: () => "echo safe" },
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });

  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
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

test("context-menu paste delegates to the binding-aware safe-paste registry", () => {
  const chrome = readFileSync(join(import.meta.dirname, "..", "src/ui/TerminalViewChrome.tsx"), "utf8");
  const registry = readFileSync(join(import.meta.dirname, "..", "src/modules/terminal/lib/terminal-action-registry.ts"), "utf8");
  const clipboard = readFileSync(join(import.meta.dirname, "..", "src/ui/lib/clipboard.ts"), "utf8");
  assert.match(chrome, /safePasteActiveTerminal\(sessionId\)/);
  assert.match(chrome, /id: "paste"[\s\S]*?icon: "paste"/);
  assert.doesNotMatch(chrome, /navigator\.clipboard|\.paste\(text\)|requestProtectedTerminalPaste/);
  assert.match(registry, /const action = captureTerminalActionTarget\(sessionId, registration\.terminal\);[\s\S]*?await readClipboardText\(\)/);
  assert.doesNotMatch(registry, /await navigator\.clipboard\.readText/);
  assert.match(registry, /requestProtectedTerminalPaste\([\s\S]*?\(\) => action\.isCurrent\(\)/);
  assert.match(registry, /if \(!protectedPaste && action\.isCurrent\(\)\) \{[\s\S]*?pasteWithCapturedBracketedMode\(registration\.terminal, text, bracketedPasteRequired\)/);
  assert.match(clipboard, /invoke<string>\("clipboard_read_text"\)/);
  assert.match(clipboard, /"__TAURI_INTERNALS__" in window/);
  assert.match(clipboard, /navigator\.clipboard\.readText\(\)[\s\S]*second native "Paste" button/);
});

test("Safe Paste reads the native clipboard command instead of WKWebView readText", () => {
  const cargo = readFileSync(join(import.meta.dirname, "..", "src-tauri/Cargo.toml"), "utf8");
  const lib = readFileSync(join(import.meta.dirname, "..", "src-tauri/src/lib.rs"), "utf8");
  const modules = readFileSync(join(import.meta.dirname, "..", "src-tauri/src/modules/mod.rs"), "utf8");
  const clipboardRs = readFileSync(join(import.meta.dirname, "..", "src-tauri/src/modules/clipboard.rs"), "utf8");
  const permission = readFileSync(join(import.meta.dirname, "..", "src-tauri/permissions/main.toml"), "utf8");
  const capability = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src-tauri/capabilities/default.json"), "utf8"));
  assert.match(modules, /pub mod clipboard;/);
  assert.doesNotMatch(cargo, /arboard|tauri-plugin-clipboard-manager/);
  assert.match(lib, /modules::clipboard::clipboard_read_text/);
  assert.doesNotMatch(lib, /tauri_plugin_clipboard_manager/);
  assert.match(clipboardRs, /spawn_blocking\(read_os_clipboard_text\)/);
  assert.match(clipboardRs, /pbpaste/);
  assert.match(clipboardRs, /wl-paste/);
  assert.match(clipboardRs, /xclip/);
  assert.match(permission, /"clipboard_read_text"/);
  assert.equal(capability.permissions.includes("clipboard-manager:allow-read-text"), false);
  assert.equal(capability.permissions.includes("clipboard-manager:default"), false);
});
