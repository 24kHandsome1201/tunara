import assert from "node:assert/strict";
import test from "node:test";

import { highlightMarkdownSource } from "../src/modules/editor/markdown-syntax.ts";

function reconstruct(lines) {
  return lines.map((line) => line.map((segment) => segment.text).join("")).join("\n");
}

test("Markdown source highlighting preserves every source byte", () => {
  const source = "# 标题 🐼\n\n- [链接](https://example.com/a?q=1) and `code`\n<Component value={count} />";
  const highlighted = highlightMarkdownSource(source);
  assert.equal(reconstruct(highlighted), source);
  assert.ok(highlighted.flat().some((segment) => segment.kind === "heading"));
  assert.ok(highlighted.flat().some((segment) => segment.kind === "link"));
  assert.ok(highlighted.flat().some((segment) => segment.kind === "code"));
  assert.ok(highlighted.flat().some((segment) => segment.kind === "tag"));
});

test("fenced code keeps its body literal until the matching fence closes", () => {
  const source = "```ts\nconst link = '[not](markdown)'\n```\n## After";
  const highlighted = highlightMarkdownSource(source);
  assert.equal(reconstruct(highlighted), source);
  assert.deepEqual(highlighted[1], [{ kind: "code", text: "const link = '[not](markdown)'" }]);
  assert.ok(highlighted[3].some((segment) => segment.kind === "heading"));
});

test("unclosed fences remain deterministic and empty lines stay aligned", () => {
  const source = "~~~sh\n\necho ok";
  const highlighted = highlightMarkdownSource(source);
  assert.equal(reconstruct(highlighted), source);
  assert.deepEqual(highlighted[1], [{ kind: "code", text: "" }]);
  assert.deepEqual(highlighted[2], [{ kind: "code", text: "echo ok" }]);
});
