import assert from "node:assert/strict";
import test from "node:test";

import { diffWatchedDirs } from "../src/app/lib/sync-watches.ts";

test("diffWatchedDirs returns an empty plan when prev and desired match", () => {
  const prev = new Set(["/a", "/b"]);
  const { toAcquire, toRelease, next } = diffWatchedDirs(prev, ["/a", "/b"]);
  assert.deepEqual(toAcquire, []);
  assert.deepEqual(toRelease, []);
  assert.deepEqual([...next].sort(), ["/a", "/b"]);
});

test("diffWatchedDirs marks newly desired dirs as toAcquire", () => {
  const prev = new Set(["/a"]);
  const { toAcquire, toRelease } = diffWatchedDirs(prev, ["/a", "/b", "/c"]);
  assert.deepEqual(toAcquire.sort(), ["/b", "/c"]);
  assert.deepEqual(toRelease, []);
});

test("diffWatchedDirs marks dropped dirs as toRelease", () => {
  const prev = new Set(["/a", "/b", "/c"]);
  const { toAcquire, toRelease } = diffWatchedDirs(prev, ["/a"]);
  assert.deepEqual(toAcquire, []);
  assert.deepEqual(toRelease.sort(), ["/b", "/c"]);
});

test("diffWatchedDirs skips falsy/empty entries from the desired iterable so they never become watch keys", () => {
  const prev = new Set();
  const { toAcquire, next } = diffWatchedDirs(prev, ["/a", "", null, undefined, "/b"]);
  assert.deepEqual(toAcquire.sort(), ["/a", "/b"]);
  assert.equal(next.has(""), false);
  assert.equal(next.has(null), false);
});

test("diffWatchedDirs dedupes the desired iterable so the same dir is not acquired twice", () => {
  const prev = new Set();
  const { toAcquire, next } = diffWatchedDirs(prev, ["/a", "/a", "/a"]);
  assert.deepEqual(toAcquire, ["/a"]);
  assert.equal(next.size, 1);
});

test("diffWatchedDirs leaves the prev set untouched so the caller controls when to swap state", () => {
  const prev = new Set(["/a"]);
  diffWatchedDirs(prev, ["/b"]);
  assert.deepEqual([...prev], ["/a"]);
});
