import assert from "node:assert/strict";
import test from "node:test";

import { splitFocusTarget } from "../src/app/lib/split-focus.ts";

const horizontal = { mode: "horizontal", paneA: "left", paneB: "right" };
const vertical = { mode: "vertical", paneA: "top", paneB: "bottom" };

test("horizontal split only moves toward an existing left or right neighbour", () => {
  assert.equal(splitFocusTarget(horizontal, "right", "left"), "left");
  assert.equal(splitFocusTarget(horizontal, "left", "right"), "right");
  assert.equal(splitFocusTarget(horizontal, "left", "left"), null);
  assert.equal(splitFocusTarget(horizontal, "left", "up"), null);
});

test("vertical split only moves toward an existing up or down neighbour", () => {
  assert.equal(splitFocusTarget(vertical, "bottom", "up"), "top");
  assert.equal(splitFocusTarget(vertical, "top", "down"), "bottom");
  assert.equal(splitFocusTarget(vertical, "bottom", "down"), null);
  assert.equal(splitFocusTarget(vertical, "top", "right"), null);
});

test("single or incomplete split never changes focus", () => {
  assert.equal(splitFocusTarget({ mode: "single", paneA: null, paneB: null }, "a", "right"), null);
  assert.equal(splitFocusTarget({ mode: "horizontal", paneA: "a", paneB: null }, "a", "right"), null);
});
