import assert from "node:assert/strict";
import test from "node:test";

import {
  stripTerminalControlSequences,
  cleanTerminalText,
  cleanTerminalLines,
  sanitizeTerminalTitle,
} from "../src/modules/terminal/lib/terminal-utils.ts";
import { createTerminalOscGuard } from "../src/modules/terminal/lib/terminal-osc-guard.ts";
import {
  captureSafeTerminalHistory,
  safeHistoryForTerminal,
} from "../src/modules/terminal/lib/terminal-safe-history.ts";

const ESC = "\x1b";

test("stripTerminalControlSequences removes CSI SGR color sequences", () => {
  const input = `${ESC}[31mred${ESC}[0m`;
  assert.equal(stripTerminalControlSequences(input), "red");
});

test("stripTerminalControlSequences removes OSC sequences terminated by BEL", () => {
  const input = `${ESC}]0;window title\x07visible`;
  assert.equal(stripTerminalControlSequences(input), "visible");
});

test("stripTerminalControlSequences removes OSC sequences terminated by ST (ESC backslash)", () => {
  const input = `${ESC}]8;;https://example.com${ESC}\\link`;
  assert.equal(stripTerminalControlSequences(input), "link");
});

test("stripTerminalControlSequences strips lone C0 control chars but keeps newlines and tabs", () => {
  const input = "a\x00b\x08c\x7fd\te\nf";
  // NUL, BS, DEL stripped; TAB (\t = \x09) and LF (\n = \x0a) preserved.
  assert.equal(stripTerminalControlSequences(input), "abcd\te\nf");
});

test("stripTerminalControlSequences leaves plain text untouched", () => {
  assert.equal(stripTerminalControlSequences("plain text 123"), "plain text 123");
});

test("cleanTerminalText collapses all whitespace runs to a single space and trims", () => {
  const input = `  ${ESC}[1mhello${ESC}[0m   \t world  \n `;
  assert.equal(cleanTerminalText(input), "hello world");
});

test("cleanTerminalText returns empty string for control-only input", () => {
  assert.equal(cleanTerminalText(`${ESC}[2J${ESC}[H`), "");
});

test("cleanTerminalLines normalizes CRLF and CR to LF", () => {
  assert.equal(cleanTerminalLines("a\r\nb\rc"), "a\nb\nc");
});

test("cleanTerminalLines strips trailing whitespace per line and trims the end", () => {
  const input = "line one   \nline two\t\n\n   ";
  assert.equal(cleanTerminalLines(input), "line one\nline two");
});

test("cleanTerminalLines preserves interior blank lines but removes control sequences", () => {
  const input = `first${ESC}[32m\n\nthird${ESC}[0m`;
  assert.equal(cleanTerminalLines(input), "first\n\nthird");
});

test("cleanTerminalLines keeps leading indentation (only trailing space is trimmed)", () => {
  assert.equal(cleanTerminalLines("  indented\n    more   "), "  indented\n    more");
});

test("terminal titles strip controls, bidi overrides, and HerdR-style decoration", () => {
  assert.equal(sanitizeTerminalTitle("\x1b\u202eHerdR\u202c"), "HerdR");
  assert.equal(sanitizeTerminalTitle("────────────────────────────────────────"), null);
  assert.equal(sanitizeTerminalTitle("HerdR" + "─".repeat(100)), "HerdR");
  assert.ok(sanitizeTerminalTitle("HerdR".repeat(80))?.endsWith("…"));
});

test("terminal title limits are UTF-8 and grapheme safe", () => {
  const title = sanitizeTerminalTitle("👩🏽‍💻".repeat(200));
  assert.ok(title);
  assert.ok(new TextEncoder().encode(title).byteLength <= 512);
  assert.equal(title.includes("\u200d"), true);
});

test("OSC guard never exposes an incomplete title across a reset boundary", () => {
  const guard = createTerminalOscGuard();
  assert.deepEqual(guard.push(new TextEncoder().encode("\x1b]0;HerdR")), new Uint8Array());
  guard.reset();
  assert.equal(new TextDecoder().decode(guard.push(new TextEncoder().encode("────Welcome\r\n"))), "────Welcome\r\n");
});

test("OSC guard accepts BEL, split ST, and C1 ST only after a complete target OSC", () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const guard = createTerminalOscGuard();
  assert.equal(decoder.decode(guard.push(encoder.encode("\x1b]2;safe\x07"))), "\x1b]2;safe\x07");
  assert.equal(guard.push(encoder.encode("\x1b]7;file://localhost/tmp\x1b")).byteLength, 0);
  assert.equal(decoder.decode(guard.push(encoder.encode("\\"))), "\x1b]7;file://localhost/tmp\x1b\\");
  const c1 = encoder.encode("\u009d0;ok\u009c");
  assert.deepEqual(guard.push(c1), c1);
});

test("OSC guard drops an oversized payload through its terminator without leaking text", () => {
  const guard = createTerminalOscGuard({ maxBytes: 16 });
  const payload = new Uint8Array(10 * 1024 * 1024 + 5);
  payload.set(new TextEncoder().encode("\x1b]0;"));
  payload.fill(0x61, 4, payload.length - 1);
  payload[payload.length - 1] = 0x07;
  assert.equal(guard.push(payload).byteLength, 0);
  assert.equal(new TextDecoder().decode(guard.push(new TextEncoder().encode("visible"))), "visible");
});

test("safe history projects wrapped normal-buffer cells as inert bounded text", () => {
  const rows = [
    { isWrapped: false, translateToString: () => "before\x1b]0;evil\x07" },
    { isWrapped: true, translateToString: () => " wrapped\u202e" },
    { isWrapped: false, translateToString: () => "after" },
  ];
  const terminal = {
    buffer: { normal: { length: rows.length, getLine: (index) => rows[index] } },
  };
  assert.equal(captureSafeTerminalHistory(terminal, 12), "rapped\nafter");
  const restored = safeHistoryForTerminal("safe\x1b]0;evil\x07", "restored");
  assert.equal(restored, "safe]0;evil\r\n\x1b[2m[restored]\x1b[0m\r\n");
});

test("safe history UTF-8 tail limits do not split non-BMP code points", () => {
  const terminal = {
    buffer: {
      normal: {
        length: 1,
        getLine: () => ({ isWrapped: false, translateToString: () => "前文🙂🙂🙂" }),
      },
    },
  };
  const history = captureSafeTerminalHistory(terminal, 8);
  assert.equal(history, "🙂🙂");
  assert.equal(new TextEncoder().encode(history).byteLength, 8);
});
