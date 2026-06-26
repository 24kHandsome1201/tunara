import assert from "node:assert/strict";
import test from "node:test";

import {
  applyParams,
  extractParams,
  hasParams,
  sanitizeWorkflow,
} from "../src/modules/workflows/template.ts";

test("extractParams returns ordered, de-duplicated keys", () => {
  assert.deepEqual(extractParams("echo {{a}} {{b}} {{a}}"), [{ key: "a" }, { key: "b" }]);
  assert.deepEqual(extractParams("no params here"), []);
  // Whitespace inside the braces is tolerated.
  assert.deepEqual(extractParams("x {{ host }} y"), [{ key: "host" }]);
});

test("hasParams detects placeholders", () => {
  assert.equal(hasParams("ssh {{host}}"), true);
  assert.equal(hasParams("ls -la"), false);
  // Called twice to guard against a sticky-regex lastIndex bug.
  assert.equal(hasParams("ssh {{host}}"), true);
  assert.equal(hasParams("ssh {{host}}"), true);
});

test("applyParams substitutes values and blanks missing ones", () => {
  assert.equal(
    applyParams("ssh -L {{port}}:localhost:{{port}} {{host}}", { port: "8080", host: "box" }),
    "ssh -L 8080:localhost:8080 box",
  );
  // Missing value → empty string, not the literal placeholder.
  assert.equal(applyParams("a {{x}} b", {}), "a  b");
  // Unknown extra values are ignored.
  assert.equal(applyParams("hi {{x}}", { x: "there", y: "ignored" }), "hi there");
});

test("sanitizeWorkflow rejects malformed entries", () => {
  assert.equal(sanitizeWorkflow(null), null);
  assert.equal(sanitizeWorkflow({ id: "1", name: "", template: "x" }), null);
  assert.equal(sanitizeWorkflow({ id: "1", name: "n", template: "  " }), null);
  assert.equal(sanitizeWorkflow({ name: "n", template: "x" }), null); // no id
  assert.deepEqual(
    sanitizeWorkflow({ id: "1", name: " n ", template: "x", description: " d " }),
    { id: "1", name: "n", template: "x", description: "d" },
  );
  // Empty description is dropped, not kept as "".
  assert.deepEqual(
    sanitizeWorkflow({ id: "1", name: "n", template: "x", description: "" }),
    { id: "1", name: "n", template: "x" },
  );
});
