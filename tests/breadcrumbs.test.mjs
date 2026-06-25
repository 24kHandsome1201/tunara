import assert from "node:assert/strict";
import test from "node:test";

import { breadcrumbSegments } from "../src/ui/lib/breadcrumbs.ts";

test("breadcrumbSegments returns the root segment only when currentPath equals rootDir", () => {
  const segs = breadcrumbSegments("/Users/me/code", "/Users/me/code");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].label, "code");
  assert.equal(segs[0].targetPath, "/Users/me/code");
  assert.equal(segs[0].isCollapsed, undefined);
});

test("breadcrumbSegments labels the root as '/' when rootDir is the filesystem root", () => {
  const segs = breadcrumbSegments("/", "/");
  assert.deepEqual(segs, [{ label: "/", targetPath: "/" }]);
});

test("breadcrumbSegments builds an incremental targetPath for each tail segment relative to root", () => {
  const segs = breadcrumbSegments("/Users/me/code/app/src", "/Users/me/code");
  assert.deepEqual(segs.map((s) => s.label), ["code", "app", "src"]);
  assert.equal(segs[0].targetPath, "/Users/me/code");
  assert.equal(segs[1].targetPath, "/Users/me/code/app");
  assert.equal(segs[2].targetPath, "/Users/me/code/app/src");
});

test("breadcrumbSegments treats absolute paths as relative to rootDir when prefix matches with trailing slash", () => {
  const segs = breadcrumbSegments("/repo/a/b", "/repo");
  assert.deepEqual(segs.map((s) => s.label), ["repo", "a", "b"]);
  assert.equal(segs.at(-1).targetPath, "/repo/a/b");
});

test("breadcrumbSegments returns full path when rootDir prefix is not a parent of currentPath", () => {
  const segs = breadcrumbSegments("/var/log/system.log", "/Users/me");
  assert.deepEqual(segs.map((s) => s.label), ["me", "var", "log", "system.log"]);
});

test("breadcrumbSegments builds tail targets from filesystem root when rootDir is '/'", () => {
  const segs = breadcrumbSegments("/usr/local/bin", "/");
  assert.deepEqual(segs.map((s) => s.label), ["/", "usr", "local", "bin"]);
  assert.equal(segs[1].targetPath, "/usr");
  assert.equal(segs[2].targetPath, "/usr/local");
  assert.equal(segs[3].targetPath, "/usr/local/bin");
});

test("breadcrumbSegments collapses the middle when total segments exceed 4", () => {
  const segs = breadcrumbSegments("/r/a/b/c/d/e", "/r");
  assert.equal(segs.length, 4);
  assert.equal(segs[0].label, "…");
  assert.equal(segs[0].isCollapsed, true);
  assert.deepEqual(segs.slice(1).map((s) => s.label), ["c", "d", "e"]);
});

test("breadcrumbSegments points the collapsed entry at the deepest hidden ancestor so clicking it surfaces context", () => {
  // full chain: [r, a, b, c, d, e] (length 6) → collapsed to […, c, d, e]
  // The '…' should jump to 'b' (the one immediately before the kept tail).
  const segs = breadcrumbSegments("/r/a/b/c/d/e", "/r");
  assert.equal(segs[0].label, "…");
  assert.equal(segs[0].targetPath, "/r/a/b");
});

test("breadcrumbSegments keeps exactly the trailing 3 segments after collapse regardless of depth", () => {
  const segs = breadcrumbSegments("/r/a/b/c/d/e/f/g/h", "/r");
  assert.equal(segs.length, 4);
  assert.deepEqual(segs.slice(1).map((s) => s.label), ["f", "g", "h"]);
});
