import assert from "node:assert/strict";
import test from "node:test";

import { decideBadge, createDockBadgeController } from "../src/ui/lib/dock-badge-state.ts";
import { deriveAttentionRow, dockBadgeCount } from "../src/modules/session/session-attention.ts";

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

test("dockBadgeCount equals the sidebar needs-you N, not unread or running", () => {
  const sessions = [
    { id: "a", agent: "CC", agentActivity: "waiting_confirmation", unread: true, updatedAt: 1 },
    { id: "b", agent: "CX", agentActivity: "waiting_confirmation", updatedAt: 2 },
    { id: "c", unread: true, updatedAt: 3 },
    { id: "d", agent: "CC", agentActivity: "running", updatedAt: 4 },
  ];
  const row = deriveAttentionRow(sessions);
  assert.equal(row.kind, "needs-you");
  assert.equal(dockBadgeCount(sessions), 2);
  assert.equal(dockBadgeCount(sessions), row.count);
});

test("dockBadgeCount returns 0 for an empty list", () => {
  assert.equal(dockBadgeCount([]), 0);
});
