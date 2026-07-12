import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  markdownHeadingSlug,
  parseMarkdownDocument,
  safeMarkdownLanguage,
  splitGfmTableRow,
} from "../src/modules/editor/markdown-reader.ts";

test("headings produce semantic toc entries and stable unique unicode anchors", () => {
  const parsed = parseMarkdownDocument("# 快速开始\n## Install & Run\n## Install & Run\n# **快速开始**");
  assert.deepEqual(parsed.toc, [
    { level: 1, text: "快速开始", id: "快速开始" },
    { level: 2, text: "Install & Run", id: "install-run" },
    { level: 2, text: "Install & Run", id: "install-run-2" },
    { level: 1, text: "快速开始", id: "快速开始-2" },
  ]);
  assert.deepEqual(parsed.blocks.filter((block) => block.type === "heading").map((block) => block.id), parsed.toc.map((entry) => entry.id));
});

test("empty or punctuation-only headings receive deterministic section anchors", () => {
  assert.equal(markdownHeadingSlug("!!!"), "section");
  const parsed = parseMarkdownDocument("# !!!\n# ???");
  assert.deepEqual(parsed.toc.map((entry) => entry.id), ["section", "section-2"]);
});

test("GFM tables parse alignment, escaped pipes, inline code pipes, and pad short rows", () => {
  assert.deepEqual(splitGfmTableRow("| a \\| b | `x|y` |"), ["a | b", "`x|y`"]);
  const parsed = parseMarkdownDocument([
    "| Name | Count | Note |",
    "| :--- | ---: | :---: |",
    "| Tuna | 2 | warm |",
    "| Otter | 1 |",
  ].join("\n"));
  assert.deepEqual(parsed.blocks[0], {
    type: "table",
    header: ["Name", "Count", "Note"],
    rows: [["Tuna", "2", "warm"], ["Otter", "1", ""]],
    alignments: ["left", "right", "center"],
    key: "table-Name|Count|Note",
  });
});

test("backtick and tilde fences retain the language label and exact body", () => {
  const parsed = parseMarkdownDocument("```ts\nconst x = 1;\n```\n\n~~~~bash\necho ok\n~~~~");
  assert.deepEqual(parsed.blocks.map((block) => block.type === "code" ? [block.language, block.text] : null), [
    ["ts", "const x = 1;"],
    ["bash", "echo ok"],
  ]);
});

test("reader block keys stay unique for repeated content", () => {
  const parsed = parseMarkdownDocument("same\n\nsame\n\n---\n---");
  const keys = parsed.blocks.map((block) => block.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("language metadata is short and safe before entering labels or CSS classes", () => {
  assert.deepEqual(safeMarkdownLanguage("Type Script<script>"), {
    label: "Type Script<script>",
    className: "language-type-script-script",
  });
  const long = safeMarkdownLanguage("x".repeat(80));
  assert.equal(long.label.length, 32);
  assert.equal(long.label.endsWith("…"), true);
  assert.equal(long.className, `language-${"x".repeat(24)}`);
  assert.deepEqual(safeMarkdownLanguage("中文"), { label: "中文" });
});

test("FilePreview renders semantic headings, toc navigation, tables, and language labels", async () => {
  const source = await readFile(new URL("../src/ui/FilePreview.tsx", import.meta.url), "utf8");
  assert.match(source, /<nav aria-label=/);
  assert.match(source, /<details open=\{document\.toc\.length <= 4\}/);
  assert.match(source, /maxHeight: "min\(35vh, 240px\)"/);
  assert.match(source, /<h1 id=\{block\.id\} tabIndex=\{-1\}/);
  assert.match(source, /<h2 id=\{block\.id\} tabIndex=\{-1\}/);
  assert.match(source, /<h3 id=\{block\.id\} tabIndex=\{-1\}/);
  assert.match(source, /<table style=\{\{ width: "max-content", minWidth: "100%"/);
  assert.match(source, /minWidth: 96, maxWidth: 280/);
  assert.match(source, /role="region" tabIndex=\{0\} aria-label=\{staticT\("preview\.markdown\.table"\)\}/);
  assert.match(source, /<figure aria-label=/);
  assert.match(source, /<pre tabIndex=\{0\} aria-label=/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /target="_blank" rel="noreferrer noopener"/);
  assert.match(source, /safeMarkdownLanguage\(block\.language\)/);
  assert.match(source, /\/\\\.mdx\?\$\/i\.test\(fileName\)/);
  assert.match(source, /data-markdown-find-index/);
  assert.match(source, /if \(mode === "preview" && isMarkdown\) return;/);
  assert.match(source, /onMatchCountChange=\{setPreviewMatchCount\}/);
  assert.doesNotMatch(source, /function parseMarkdown/);
});
