import assert from "node:assert/strict";
import test from "node:test";

import { formatElapsed } from "../src/ui/lib/elapsed.ts";

test("formatElapsed clamps future timestamps instead of rendering negative time", () => {
  assert.equal(formatElapsed(-207_000), "0s");
  assert.equal(formatElapsed(-1), "0s");
});

test("formatElapsed keeps compact second, minute, and hour buckets", () => {
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(61_000), "1m 1s");
  assert.equal(formatElapsed(3_661_000), "1h 1m");
});
