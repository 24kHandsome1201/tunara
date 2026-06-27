import assert from "node:assert/strict";
import test from "node:test";

import {
  STARTER_WORKFLOW_BLUEPRINTS,
  makeStarterWorkflows,
  missingStarterWorkflows,
} from "../src/modules/workflows/starters.ts";

const translate = (key) => `t:${key}`;

test("starter workflow ids and templates stay unique", () => {
  assert.equal(new Set(STARTER_WORKFLOW_BLUEPRINTS.map((starter) => starter.id)).size, STARTER_WORKFLOW_BLUEPRINTS.length);
  assert.equal(new Set(STARTER_WORKFLOW_BLUEPRINTS.map((starter) => starter.template)).size, STARTER_WORKFLOW_BLUEPRINTS.length);
});

test("makeStarterWorkflows localizes names and descriptions", () => {
  const workflows = makeStarterWorkflows(translate);
  assert.equal(workflows.length, STARTER_WORKFLOW_BLUEPRINTS.length);
  assert.equal(workflows[0].name, `t:${STARTER_WORKFLOW_BLUEPRINTS[0].nameKey}`);
  assert.equal(workflows[0].description, `t:${STARTER_WORKFLOW_BLUEPRINTS[0].descriptionKey}`);
});

test("missingStarterWorkflows filters by id or matching template", () => {
  const [first, second, ...rest] = makeStarterWorkflows(translate);
  const missing = missingStarterWorkflows([
    { ...first, name: "custom name" },
    { id: "custom", name: "Already have tests", template: second.template, description: "" },
  ], translate);

  assert.deepEqual(missing.map((workflow) => workflow.id), rest.map((workflow) => workflow.id));
});
