import assert from "node:assert/strict";
import test from "node:test";

import { computeVirtualSlice, VIRTUAL_BUFFER } from "../src/ui/lib/diff-virtual.ts";

test("computeVirtualSlice returns empty for zero total", () => {
  const s = computeVirtualSlice(0, 0, 400, 16);
  assert.equal(s.first, 0);
  assert.equal(s.last, 0);
  assert.equal(s.topPad, 0);
  assert.equal(s.bottomPad, 0);
});

test("computeVirtualSlice renders the first viewport with buffer", () => {
  // 5000 rows, 16px each → 80000px total. Viewport 400px → 25 rows visible.
  const s = computeVirtualSlice(5000, 0, 400, 16);
  assert.equal(s.first, 0);
  // 25 visible + 8 buffer below.
  assert.equal(s.last, 25 + VIRTUAL_BUFFER);
  assert.equal(s.topPad, 0);
  assert.equal(s.bottomPad, (5000 - s.last) * 16);
});

test("computeVirtualSlice offsets first when scrolled", () => {
  // Scroll to row 1000 (scrollTop = 16000).
  const s = computeVirtualSlice(5000, 16000, 400, 16);
  // firstVisible = 1000, first = 1000 - 8 = 992.
  assert.equal(s.first, 992);
  // last = 1000 + 25 + 8 = 1033.
  assert.equal(s.last, 1033);
  assert.equal(s.topPad, 992 * 16);
  assert.equal(s.bottomPad, (5000 - 1033) * 16);
});

test("computeVirtualSlice clamps scrollTop past the end", () => {
  // Scroll way past the end; the slice should not go out of bounds.
  const s = computeVirtualSlice(100, 999999, 400, 16);
  assert.ok(s.last <= 100, "last must not exceed total");
  assert.ok(s.first <= 100, "first must not exceed total");
  assert.equal(s.bottomPad, (100 - s.last) * 16);
});

test("computeVirtualSlice handles a filtered short list", () => {
  // After search filtering, only 10 rows remain but scrollTop is still high.
  const s = computeVirtualSlice(10, 5000, 400, 16);
  // Clamped to maxScroll = 10*16 - 400 = -240 → 0, so first = 0.
  assert.equal(s.first, 0);
  assert.equal(s.last, 10);
  assert.equal(s.topPad, 0);
  assert.equal(s.bottomPad, 0);
});

test("computeVirtualSlice buffer keeps context rows around viewport", () => {
  const s = computeVirtualSlice(5000, 16000, 400, 16, 5);
  assert.equal(s.first, 1000 - 5);
  assert.equal(s.last, 1000 + 25 + 5);
});
