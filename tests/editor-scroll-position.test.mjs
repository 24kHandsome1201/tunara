import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedScrollPosition,
  scrollTopForPosition,
} from "../src/modules/editor/scroll-position.ts";

test("scroll context maps proportionally between source and preview surfaces", () => {
  const sourceRatio = normalizedScrollPosition(450, 1200, 300);
  assert.equal(sourceRatio, 0.5);
  assert.equal(scrollTopForPosition(sourceRatio, 2100, 500), 800);
});

test("scroll context clamps degenerate and untrusted geometry", () => {
  assert.equal(normalizedScrollPosition(100, 200, 200), 0);
  assert.equal(normalizedScrollPosition(-10, 1000, 200), 0);
  assert.equal(normalizedScrollPosition(900, 1000, 200), 1);
  assert.equal(normalizedScrollPosition(Number.NaN, 1000, 200), 0);
  assert.equal(scrollTopForPosition(2, 1000, 200), 800);
  assert.equal(scrollTopForPosition(Number.NaN, 1000, 200), 0);
});
