import assert from "node:assert/strict";
import test from "node:test";

import { shouldRestoreFocusAfterTrapUnmount } from "../src/ui/overlays/focus-trap-policy.ts";

test("focus trap restores the previous target when its own focused content closes", () => {
  assert.equal(shouldRestoreFocusAfterTrapUnmount(true, false), true);
});

test("focus trap restores the previous target when focus falls back to the document root", () => {
  assert.equal(shouldRestoreFocusAfterTrapUnmount(false, true), true);
});

test("focus trap preserves focus already claimed by the next overlay", () => {
  assert.equal(shouldRestoreFocusAfterTrapUnmount(false, false), false);
});
