import assert from "node:assert/strict";
import test from "node:test";

import { highlightMarkdownSource } from "../src/modules/editor/markdown-syntax.ts";
import {
  LOG_MAX_CHARS,
  SHIKI_MAX_BYTES,
  highlightDiffBodies,
  highlightSource,
} from "../src/modules/editor/syntax-highlight.ts";

function reconstruct(lines) {
  return lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

test("markdown files stay on the editor highlighter", async () => {
  const source = "# Title\n\n- [link](https://example.com)\n";
  const highlighted = await highlightSource("README.md", source);
  assert.deepEqual(highlighted, highlightMarkdownSource(source));
  assert.ok(highlighted.flat().some((segment) => segment.kind === "heading"));
  assert.ok(highlighted.flat().some((segment) => segment.kind === "link"));
});

test("log files use the line-local tokenizer", async () => {
  const source = "2026-01-01T00:00:00Z ERROR boom\n";
  const highlighted = await highlightSource("app.log", source);
  assert.equal(reconstruct(highlighted), source);
  assert.ok(highlighted.flat().some((segment) => segment.kind === "log-error"));
});

test("typescript files map TextMate scopes onto kind tokens without hex colors", async () => {
  const source = "export function greet(name: string) {\n  const n = 42;\n  // hi\n  return name;\n}\n";
  const highlighted = await highlightSource("greet.ts", source);
  assert.ok(highlighted);
  assert.equal(reconstruct(highlighted), source);
  const kinds = new Set(highlighted.flat().map((segment) => segment.kind));
  assert.ok(kinds.has("keyword"), `missing keyword in ${[...kinds].join(",")}`);
  assert.ok(kinds.has("function"), `missing function in ${[...kinds].join(",")}`);
  assert.ok(kinds.has("number"), `missing number in ${[...kinds].join(",")}`);
  assert.ok(kinds.has("comment"), `missing comment in ${[...kinds].join(",")}`);
  assert.ok(!highlighted.flat().some((segment) => typeof segment.kind === "string" && segment.kind.startsWith("#")));
});

test("size caps skip Shiki and oversized logs", async () => {
  const hugeTs = `${"const x = 1;\n".repeat(8_001)}`;
  assert.equal(await highlightSource("huge.ts", hugeTs), null);
  const wideTs = `const x = "${"a".repeat(SHIKI_MAX_BYTES)}";\n`;
  assert.equal(await highlightSource("wide.ts", wideTs), null);
  const hugeLog = `${"2026-01-01T00:00:00Z INFO ok\n".repeat(Math.ceil(LOG_MAX_CHARS / 20))}`;
  assert.ok(hugeLog.length > LOG_MAX_CHARS);
  assert.equal(await highlightSource("app.log", hugeLog), null);
});

test("unknown languages and oversized diffs stay uncolored", async () => {
  assert.equal(await highlightSource("notes.bin", "not a language"), null);
  const bodies = Array.from({ length: 2_000 }, (_, index) => `const n${index} = ${index};`);
  assert.equal(await highlightDiffBodies("a.ts", bodies), null);
  const small = await highlightDiffBodies("a.ts", ["const n = 1;"]);
  assert.ok(small);
  assert.ok(small.flat().some((segment) => segment.kind === "keyword"));
});
