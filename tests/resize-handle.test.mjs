import assert from "node:assert/strict";
import test from "node:test";

import { resolveResizeHandleWidth } from "../src/app/lib/resize-handle.ts";

const sidebar = {
  shiftKey: false,
  currentWidth: 272,
  minWidth: 200,
  maxWidth: 400,
  defaultWidth: 272,
  direction: 1,
};

test("sidebar resize keys follow the visual left/right direction", () => {
  assert.equal(resolveResizeHandleWidth({ ...sidebar, key: "ArrowLeft" }), 264);
  assert.equal(resolveResizeHandleWidth({ ...sidebar, key: "ArrowRight" }), 280);
  assert.equal(resolveResizeHandleWidth({ ...sidebar, key: "ArrowRight", shiftKey: true }), 304);
  assert.equal(resolveResizeHandleWidth({ ...sidebar, key: "Home" }), 200);
  assert.equal(resolveResizeHandleWidth({ ...sidebar, key: "End" }), 400);
  assert.equal(resolveResizeHandleWidth({ ...sidebar, key: "Enter" }), 272);
});

test("right-side Inspector resize keys follow the visual left/right direction", () => {
  const inspector = { ...sidebar, minWidth: 240, maxWidth: 540, defaultWidth: 320, direction: -1 };
  assert.equal(resolveResizeHandleWidth({ ...inspector, key: "ArrowLeft" }), 280);
  assert.equal(resolveResizeHandleWidth({ ...inspector, key: "ArrowRight" }), 264);
  assert.equal(resolveResizeHandleWidth({ ...inspector, key: "Home" }), 540);
  assert.equal(resolveResizeHandleWidth({ ...inspector, key: "End" }), 240);
  assert.equal(resolveResizeHandleWidth({ ...inspector, key: " " }), 320);
  assert.equal(resolveResizeHandleWidth({ ...inspector, key: "Escape" }), null);
});
