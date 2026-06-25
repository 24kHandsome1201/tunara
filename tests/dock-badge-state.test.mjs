import assert from "node:assert/strict";
import test from "node:test";

import { decideBadge, createDockBadgeController } from "../src/ui/lib/dock-badge-state.ts";
import { countUnread } from "../src/app/lib/unread-count.ts";

test("decideBadge reports unchanged when count matches the previously committed value", () => {
  assert.deepEqual(decideBadge(3, 3), { changed: false, value: 3 });
  assert.deepEqual(decideBadge(0, 0), { changed: false, value: undefined });
});

test("decideBadge maps a zero count to a cleared badge (value: undefined)", () => {
  const decision = decideBadge(5, 0);
  assert.equal(decision.changed, true);
  assert.equal(decision.value, undefined);
});

test("decideBadge passes the numeric count through when count > 0", () => {
  assert.deepEqual(decideBadge(null, 7), { changed: true, value: 7 });
  assert.deepEqual(decideBadge(2, 9), { changed: true, value: 9 });
});

test("decideBadge transitions from a fresh (null) state on the first call", () => {
  assert.deepEqual(decideBadge(null, 0), { changed: true, value: undefined });
  assert.deepEqual(decideBadge(null, 4), { changed: true, value: 4 });
});

test("createDockBadgeController suppresses identical consecutive calls", () => {
  const ctrl = createDockBadgeController();
  const first = ctrl.set(3);
  const second = ctrl.set(3);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(ctrl.peek(), 3);
});

test("createDockBadgeController stays at the last committed value if a duplicate call is rejected", () => {
  const ctrl = createDockBadgeController();
  ctrl.set(2);
  ctrl.set(2);
  ctrl.set(2);
  assert.equal(ctrl.peek(), 2);
});

test("createDockBadgeController.reset clears the cached previous so the next set is treated as a change", () => {
  const ctrl = createDockBadgeController();
  ctrl.set(4);
  ctrl.reset();
  const decision = ctrl.set(4);
  assert.equal(decision.changed, true);
});

test("countUnread sums sessions whose unread flag is truthy", () => {
  const sessions = [
    { unread: true },
    { unread: false },
    { unread: true },
    {},
    { unread: undefined },
  ];
  assert.equal(countUnread(sessions), 2);
});

test("countUnread returns 0 for an empty list", () => {
  assert.equal(countUnread([]), 0);
});
