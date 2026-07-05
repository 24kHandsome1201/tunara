import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNBOOK_BLUEPRINTS,
  appendRunbookToNote,
} from "../src/modules/runbook/blueprints.ts";

test("runbook blueprint ids and templates stay unique", () => {
  assert.equal(new Set(RUNBOOK_BLUEPRINTS.map((item) => item.id)).size, RUNBOOK_BLUEPRINTS.length);
  assert.equal(new Set(RUNBOOK_BLUEPRINTS.map((item) => item.template)).size, RUNBOOK_BLUEPRINTS.length);
});

test("runbook blueprints cover start check fix rollback test", () => {
  assert.deepEqual(
    RUNBOOK_BLUEPRINTS.map((item) => item.id),
    [
      "runbook:start",
      "runbook:check",
      "runbook:fix",
      "runbook:rollback",
      "runbook:test",
    ],
  );
});

test("appendRunbookToNote appends trimmed template blocks", () => {
  assert.equal(appendRunbookToNote("", "pnpm test"), "pnpm test\n");
  assert.equal(appendRunbookToNote("line one", "pnpm test"), "line one\n\npnpm test\n");
  assert.equal(appendRunbookToNote("line one\n", "  \n"), "line one\n");
});