import assert from "node:assert/strict";
import test from "node:test";

import {
  stripTerminalControlSequences,
  cleanTerminalText,
  cleanTerminalLines,
} from "../src/modules/terminal/lib/terminal-utils.ts";

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
