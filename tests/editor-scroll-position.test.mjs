import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedScrollPosition,
  offsetForLineColumn,
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

test("line/column targets resolve to clamped text offsets", () => {
  const content = "alpha\nbeta\ngamma";
  assert.equal(offsetForLineColumn(content, 1), 0);
  assert.equal(offsetForLineColumn(content, 2), 6);
  assert.equal(offsetForLineColumn(content, 2, 3), 8);
  assert.equal(offsetForLineColumn(content, 2, 99), 10);
  assert.equal(offsetForLineColumn(content, 3, 2), 12);
  assert.equal(offsetForLineColumn(content, 42), 11);
  assert.equal(offsetForLineColumn(content, 0, -4), 0);
  assert.equal(offsetForLineColumn("", 5, 5), 0);
});
