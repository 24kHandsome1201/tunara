import assert from "node:assert/strict";
import test from "node:test";

import { parseNotebook } from "../src/modules/editor/notebook.ts";

test("notebook parser keeps source cells and safe text outputs", () => {
  const parsed = parseNotebook(JSON.stringify({
    nbformat: 4,
    metadata: { kernelspec: { display_name: "Python 3" } },
    cells: [
      { cell_type: "markdown", source: ["# Heading\n", "Safe prose"] },
      {
        cell_type: "code",
        execution_count: 7,
        source: "print('ok')",
        outputs: [
          { output_type: "stream", text: ["ok", "\n"] },
          { output_type: "execute_result", data: { "text/plain": ["{'safe': ", "true}"] } },
          { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line 1", "ValueError: bad"] },
        ],
      },
      { cell_type: "raw", source: "raw text" },
    ],
  }));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.notebook.language, "Python 3");
  assert.deepEqual(parsed.notebook.cells, [
    { kind: "markdown", source: "# Heading\nSafe prose" },
    {
      kind: "code",
      source: "print('ok')",
      executionCount: 7,
      outputs: [
        { kind: "text", text: "ok\n" },
        { kind: "text", text: "{'safe': true}" },
        { kind: "error", name: "ValueError", value: "bad", traceback: ["line 1", "ValueError: bad"] },
      ],
    },
    { kind: "raw", source: "raw text" },
  ]);
});

test("notebook parser never exposes HTML, scripts, or image payloads as renderable output", () => {
  const script = "<script>globalThis.PWNED = true</script>";
  const parsed = parseNotebook(JSON.stringify({
    nbformat: 4,
    metadata: {},
    cells: [{
      cell_type: "code",
      source: "display(payload)",
      outputs: [
        { output_type: "display_data", data: { "text/html": script } },
        { output_type: "display_data", data: { "image/png": "very-large-base64" } },
        { output_type: "display_data", data: { "text/html": script, "text/plain": "safe fallback" } },
      ],
    }],
  }));

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.notebook.cells[0].outputs, [
    { kind: "omitted" },
    { kind: "omitted" },
    { kind: "text", text: "safe fallback" },
  ]);
  assert.equal(JSON.stringify(parsed.notebook).includes(script), false);
  assert.equal(JSON.stringify(parsed.notebook).includes("very-large-base64"), false);
});

test("notebook parser fails closed for malformed or structurally invalid JSON", () => {
  assert.equal(parseNotebook("{broken").ok, false);
  assert.deepEqual(parseNotebook(JSON.stringify({ nbformat: 4 })), {
    ok: false,
    message: "Missing notebook cells or nbformat",
  });
});
