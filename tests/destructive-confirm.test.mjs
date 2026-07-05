import assert from "node:assert/strict";
import test from "node:test";

import {
  DESTRUCTIVE_CONFIRM_WINDOW_MS,
  getDestructiveConfirmRemainingMs,
  getDestructiveConfirmRemainingSeconds,
} from "../src/ui/lib/destructive-confirm.ts";

test("getDestructiveConfirmRemainingMs counts down within the confirm window", () => {
  const confirmedAt = 1_000_000;
  assert.equal(getDestructiveConfirmRemainingMs(0, confirmedAt + 500), 0);
  assert.equal(
    getDestructiveConfirmRemainingMs(confirmedAt, confirmedAt),
    DESTRUCTIVE_CONFIRM_WINDOW_MS,
  );
  assert.equal(
    getDestructiveConfirmRemainingMs(confirmedAt, confirmedAt + 1_000),
    DESTRUCTIVE_CONFIRM_WINDOW_MS - 1_000,
  );
  assert.equal(getDestructiveConfirmRemainingMs(confirmedAt, confirmedAt + DESTRUCTIVE_CONFIRM_WINDOW_MS), 0);
  assert.equal(getDestructiveConfirmRemainingMs(confirmedAt, confirmedAt + DESTRUCTIVE_CONFIRM_WINDOW_MS + 500), 0);
});

test("getDestructiveConfirmRemainingSeconds rounds up partial seconds", () => {
  const confirmedAt = 2_000_000;
  assert.equal(getDestructiveConfirmRemainingSeconds(confirmedAt, confirmedAt + 1), 3);
  assert.equal(getDestructiveConfirmRemainingSeconds(confirmedAt, confirmedAt + 1_001), 2);
  assert.equal(getDestructiveConfirmRemainingSeconds(confirmedAt, confirmedAt + DESTRUCTIVE_CONFIRM_WINDOW_MS), 0);
});