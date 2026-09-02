import assert from "node:assert/strict";
import test from "node:test";

import {
  canSplitLayout,
  emptySplitState,
  insertReaderPane,
  insertSplitPane,
  readerPaneId,
  removeReaderPane,
  removeSplitPane,
  replaceSplitPane,
  sanitizeSplitLayout,
  setSplitRatioAt,
  splitFocusTarget,
  splitHorizontalPaneCount,
  splitLayoutGeometry,
  splitLayoutHasReader,
  splitLayoutLeafIds,
  splitLayoutSessionIds,
} from "../src/modules/session/split-layout.ts";

function insert(split, target, next, direction) {
  const result = insertSplitPane(split, target, next, direction);
  assert.ok(result);
  return result;
}

test("right and down splits place the new pane after the target and support a four-pane grid", () => {
  let split = insert(emptySplitState(), "top-left", "top-right", "horizontal");
  split = insert(split, "top-left", "bottom-left", "vertical");
  split = insert(split, "top-right", "bottom-right", "vertical");

  assert.deepEqual(splitLayoutSessionIds(split), ["top-left", "bottom-left", "top-right", "bottom-right"]);
  assert.equal(splitHorizontalPaneCount(split), 2);
  assert.equal(canSplitLayout(split), false);
  assert.equal(insertSplitPane(split, "top-left", "fifth", "horizontal"), null);

  const panes = splitLayoutGeometry(split).panes;
  assert.deepEqual(panes["top-left"], { x: 0, y: 0, width: 0.5, height: 0.5, parentDirection: "vertical" });
  assert.deepEqual(panes["bottom-left"], { x: 0, y: 0.5, width: 0.5, height: 0.5, parentDirection: "vertical" });
  assert.deepEqual(panes["top-right"], { x: 0.5, y: 0, width: 0.5, height: 0.5, parentDirection: "vertical" });
  assert.deepEqual(panes["bottom-right"], { x: 0.5, y: 0.5, width: 0.5, height: 0.5, parentDirection: "vertical" });
});

test("directional focus follows geometry in a four-pane grid", () => {
  let split = insert(emptySplitState(), "top-left", "top-right", "horizontal");
  split = insert(split, "top-left", "bottom-left", "vertical");
  split = insert(split, "top-right", "bottom-right", "vertical");

  assert.equal(splitFocusTarget(split, "top-left", "right"), "top-right");
  assert.equal(splitFocusTarget(split, "top-left", "down"), "bottom-left");
  assert.equal(splitFocusTarget(split, "bottom-right", "left"), "bottom-left");
  assert.equal(splitFocusTarget(split, "bottom-right", "up"), "top-right");
  assert.equal(splitFocusTarget(split, "top-left", "left"), null);
  assert.equal(splitFocusTarget(emptySplitState(), "top-left", "right"), null);
});

test("nested handles update only their own split ratio", () => {
  let split = insert(emptySplitState(), "left", "right", "horizontal");
  split = insert(split, "left", "lower-left", "vertical");
  split = setSplitRatioAt(split, "first", 0.7);

  assert.equal(split.root.ratio, 0.5);
  assert.equal(split.root.first.ratio, 0.7);
  assert.equal(splitLayoutGeometry(split).panes.left.height, 0.7);
  assert.ok(Math.abs(splitLayoutGeometry(split).panes["lower-left"].height - 0.3) < 1e-9);
});

test("removing a pane promotes its sibling subtree and replacing a pane keeps the layout", () => {
  let split = insert(emptySplitState(), "left", "right", "horizontal");
  split = insert(split, "left", "lower-left", "vertical");
  split = replaceSplitPane(split, "right", "replacement");
  assert.deepEqual(splitLayoutSessionIds(split), ["left", "lower-left", "replacement"]);

  const removed = removeSplitPane(split, "left");
  assert.equal(removed.removed, true);
  assert.equal(removed.focusSessionId, "lower-left");
  assert.deepEqual(splitLayoutSessionIds(removed.split), ["lower-left", "replacement"]);

  const collapsed = removeSplitPane(removed.split, "replacement");
  assert.equal(collapsed.split.root, null);
  assert.equal(collapsed.focusSessionId, "lower-left");
});

test("sanitization prunes invalid and duplicate panes without discarding the valid tree", () => {
  const raw = {
    type: "split",
    direction: "horizontal",
    ratio: 0.95,
    first: {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "pane", sessionId: "a" },
      second: { type: "pane", sessionId: "missing" },
    },
    second: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", sessionId: "b" },
      second: { type: "pane", sessionId: "a" },
    },
  };

  const split = sanitizeSplitLayout(raw, new Set(["a", "b"]));
  assert.deepEqual(splitLayoutSessionIds(split), ["a", "b"]);
  assert.equal(split.root.ratio, 0.8);
});

test("inserting a reader pane sits to the right of its terminal at 40/60", () => {
  const split = insertReaderPane(emptySplitState(), "sess");
  assert.ok(split);
  assert.equal(split.root.direction, "horizontal");
  assert.equal(split.root.ratio, 0.4);
  assert.deepEqual(splitLayoutLeafIds(split), ["sess", "reader:sess"]);
  assert.equal(splitLayoutHasReader(split, "sess"), true);
  assert.equal(canSplitLayout(split), true);

  const panes = splitLayoutGeometry(split).panes;
  assert.equal(panes.sess.width, 0.4);
  assert.equal(panes[readerPaneId("sess")].x, 0.4);
  assert.equal(panes[readerPaneId("sess")].width, 0.6);
  assert.equal(splitFocusTarget(split, "sess", "right"), "reader:sess");
  assert.equal(splitFocusTarget(split, "reader:sess", "left"), "sess");
});

test("a reader pane counts toward the four-pane cap and closes independently", () => {
  let split = insert(emptySplitState(), "a", "b", "horizontal");
  split = insert(split, "a", "c", "vertical");
  split = insertReaderPane(split, "b");
  assert.equal(canSplitLayout(split), false);
  assert.equal(insertReaderPane(split, "a"), null);
  assert.equal(insertSplitPane(split, "a", "d", "horizontal"), null);

  const closed = removeReaderPane(split, "b");
  assert.equal(closed.removed, true);
  assert.equal(splitLayoutHasReader(closed.split, "b"), false);
  assert.deepEqual(splitLayoutSessionIds(closed.split), ["a", "c", "b"]);
});

test("removing a session also drops its reader leaf", () => {
  let split = insertReaderPane(emptySplitState(), "sess");
  split = insertSplitPane(split, "sess", "other", "vertical");
  const removed = removeSplitPane(split, "sess");
  assert.equal(removed.removed, true);
  assert.equal(splitLayoutHasReader(removed.split, "sess"), false);
  assert.equal(removed.split.root, null);
});
