import assert from "node:assert/strict";
import test from "node:test";

import {
  applyParams,
  extractParams,
  hasParams,
  hasPromptableParams,
  parseTemplateParams,
  promptableParams,
  resolveBuiltin,
  resolveTemplate,
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

// Workflow variables v2

test("parseTemplateParams captures defaults; promptableParams excludes built-ins", () => {
  assert.deepEqual(parseTemplateParams("deploy {{env=staging}} {{tag}}"), [
    { key: "env", default: "staging" },
    { key: "tag" },
  ]);
  // Built-ins are parsed but not promptable.
  assert.deepEqual(parseTemplateParams("git commit -m {{msg}} on {{date}}"), [
    { key: "msg" },
    { key: "date" },
  ]);
  assert.deepEqual(promptableParams("git commit -m {{msg}} on {{date}}"), [{ key: "msg" }]);
  // A template with only built-ins needs no prompt.
  assert.equal(hasPromptableParams("echo {{date}} {{uuid}}"), false);
  assert.equal(hasPromptableParams("echo {{name}}"), true);
});

test("resolveBuiltin fills date/cwd/branch/uuid from context", () => {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5); // value only used for date/time shape
  assert.match(resolveBuiltin("date", { now }), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(resolveBuiltin("time", { now }), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(resolveBuiltin("cwd", { cwd: "/home/me/app" }), "/home/me/app");
  assert.equal(resolveBuiltin("branch", { branch: "main" }), "main");
  assert.equal(resolveBuiltin("uuid", { uuid: () => "FIXED" }), "FIXED");
  // Non-built-in returns null.
  assert.equal(resolveBuiltin("host", {}), null);
});

test("resolveTemplate is a superset of applyParams and applies defaults + built-ins", () => {
  // Identical to applyParams when no defaults/built-ins involved.
  const t = "ssh -L {{port}}:localhost:{{port}} {{host}}";
  assert.equal(
    resolveTemplate(t, { port: "8080", host: "box" }),
    applyParams(t, { port: "8080", host: "box" }),
  );
  // Missing value with no default becomes empty (matches applyParams).
  assert.equal(resolveTemplate("a {{x}} b", {}), "a  b");
  // Default used when no value provided; overridden when one is.
  assert.equal(resolveTemplate("deploy {{env=staging}}", {}), "deploy staging");
  assert.equal(resolveTemplate("deploy {{env=staging}}", { env: "prod" }), "deploy prod");
  // Built-ins resolved from ctx, ignoring any provided value of the same name.
  assert.equal(
    resolveTemplate("cd {{cwd}} && git checkout {{branch}}", {}, { cwd: "/app", branch: "dev" }),
    "cd /app && git checkout dev",
  );
  assert.equal(resolveTemplate("id={{uuid}}", {}, { uuid: () => "ABC" }), "id=ABC");
});

test("v1 functions still behave exactly as before (regression)", () => {
  // The old regex/behavior must be untouched by the v2 additions.
  assert.deepEqual(extractParams("echo {{a}} {{b}} {{a}}"), [{ key: "a" }, { key: "b" }]);
  assert.equal(hasParams("ls -la"), false);
  assert.equal(applyParams("hi {{x}}", { x: "there" }), "hi there");
  // v1 extractParams does NOT understand the `=default` syntax, so a
  // `{{env=staging}}` placeholder simply doesn't match its stricter regex,
  // proving v2's additions left v1 completely untouched. Use parseTemplateParams
  // (v2) when you need defaults.
  assert.deepEqual(extractParams("deploy {{env=staging}}"), []);
});
