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
  let focused = 0;
  const term = {
    modes: { bracketedPasteMode: false },
    focus: () => { focused += 1; },
    input: (text, wasUserInput) => input.push([text, wasUserInput]),
    paste: (text) => pasted.push(text),
  };
  pasteWithCapturedBracketedMode(term, "line1\nline2", true);
  assert.deepEqual(pasted, []);
  assert.deepEqual(input, [["\u001b[200~line1\rline2\u001b[201~", true]]);
  assert.equal(focused, 1);
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
  let focused = 0;
  pasteWithCapturedBracketedMode({
    element: { isConnected: false },
    focus: () => { focused += 1; },
    input: (text) => pasted.push(text),
    paste: (text) => pasted.push(text),
  }, "line1\nline2", true);
  assert.deepEqual(pasted, []);
  assert.equal(focused, 0);
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

test("native safe-text paste preserves clipboardData for xterm's own paste handler", () => {
  let pasteListener;
  let clipboardReads = 0;
  const pastedByGuard = [];
  const element = {
    isConnected: true,
    addEventListener: (_type, listener) => { pasteListener = listener; },
    removeEventListener() {},
  };
  registerTerminalPasteProtection({
    element,
    paste: (text) => pastedByGuard.push(text),
  }, () => { throw new Error("safe text must not confirm"); });
  let prevented = 0;
  let stopped = 0;
  pasteListener({
    clipboardData: { getData: (type) => { clipboardReads += 1; assert.equal(type, "text/plain"); return "echo native"; } },
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });

  assert.equal(clipboardReads, 1);
  assert.equal(prevented, 0);
  assert.equal(stopped, 0);
  assert.deepEqual(pastedByGuard, [], "the guard must not fake xterm's downstream native handler");
});

test("native empty or image-only paste is a no-op and remains native", () => {
  for (const types of [[], ["image/png"]]) {
    let pasteListener;
    let pasted = 0;
    const element = {
      isConnected: true,
      addEventListener: (_type, listener) => { pasteListener = listener; },
      removeEventListener() {},
    };
    registerTerminalPasteProtection({ element, paste: () => { pasted += 1; } }, () => true);
    const event = {
      clipboardData: { types, getData: () => "" },
      preventDefault: () => { throw new Error("empty native paste must not be cancelled"); },
      stopPropagation: () => { throw new Error("empty native paste must not be stopped"); },
    };
    pasteListener(event);
    assert.equal(pasted, 0);
  }
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
  const titlebar = readFileSync(join(import.meta.dirname, "..", "src/ui/Titlebar.tsx"), "utf8");
  const palette = readFileSync(join(import.meta.dirname, "..", "src/ui/overlays/CommandPalette.tsx"), "utf8");
  const registry = readFileSync(join(import.meta.dirname, "..", "src/modules/terminal/lib/terminal-action-registry.ts"), "utf8");
  const clipboard = readFileSync(join(import.meta.dirname, "..", "src/ui/lib/clipboard.ts"), "utf8");
  assert.match(chrome, /safePasteActiveTerminal\(sessionId\)/);
  assert.match(titlebar, /safePasteActiveTerminal\(activeSessionId\)/);
  assert.match(palette, /safePasteActiveTerminal\(activeSession\.id\)/);
  assert.match(chrome, /id: "paste"[\s\S]*?icon: "paste"/);
  for (const surface of [chrome, titlebar, palette]) {
    assert.doesNotMatch(surface, /navigator\.clipboard|\.paste\(text\)|requestProtectedTerminalPaste|plugin-clipboard-manager/);
  }
  assert.match(registry, /const action = captureTerminalActionTarget\(sessionId, registration\.terminal\);[\s\S]*?await readClipboardText\(\)/);
  assert.doesNotMatch(registry, /await navigator\.clipboard\.readText/);
  assert.match(registry, /requestProtectedTerminalPaste\([\s\S]*?\(\) => action\.isCurrent\(\)/);
  assert.match(registry, /if \(!protectedPaste && action\.isCurrent\(\)\) \{[\s\S]*?pasteWithCapturedBracketedMode\(registration\.terminal, text, bracketedPasteRequired\)/);
  assert.match(clipboard, /import \{ readText \} from "@tauri-apps\/plugin-clipboard-manager"/);
  assert.match(clipboard, /return await readText\(\)/);
  assert.doesNotMatch(clipboard, /navigator\.clipboard\.readText|invoke<.*clipboard/);
});

test("menu Safe Paste uses least-privilege Tauri clipboard-manager text reads", () => {
  const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  const cargo = readFileSync(join(import.meta.dirname, "..", "src-tauri/Cargo.toml"), "utf8");
  const lib = readFileSync(join(import.meta.dirname, "..", "src-tauri/src/lib.rs"), "utf8");
  const modules = readFileSync(join(import.meta.dirname, "..", "src-tauri/src/modules/mod.rs"), "utf8");
  const permission = readFileSync(join(import.meta.dirname, "..", "src-tauri/permissions/main.toml"), "utf8");
  const capability = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src-tauri/capabilities/default.json"), "utf8"));
  assert.ok(packageJson.dependencies["@tauri-apps/plugin-clipboard-manager"]);
  assert.match(cargo, /tauri-plugin-clipboard-manager = "2\.3"/);
  assert.match(lib, /tauri_plugin_clipboard_manager::init\(\)/);
  assert.doesNotMatch(lib, /clipboard_read_text/);
  assert.doesNotMatch(modules, /pub mod clipboard;/);
  assert.doesNotMatch(permission, /clipboard/);
  assert.deepEqual(capability.permissions.filter((value) => value.startsWith("clipboard-manager:")), [
    "clipboard-manager:allow-read-text",
  ]);
  assert.equal(capability.permissions.includes("clipboard-manager:allow-write-text"), false);
  assert.equal(capability.permissions.includes("clipboard-manager:default"), false);
});
