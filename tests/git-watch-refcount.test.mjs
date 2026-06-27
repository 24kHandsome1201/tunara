import assert from "node:assert/strict";
import test from "node:test";

import { createWatchRefCount } from "../src/modules/git/lib/watch-refcount.ts";
import {
  normalizeLocalRepoPath,
  normalizeRepoPath,
  sameRepoPath,
} from "../src/modules/git/lib/path-normalize.ts";

function makeSpyHandlers() {
  const acquires = [];
  const releases = [];
  return {
    acquires,
    releases,
    handlers: {
      onFirstAcquire: (k) => acquires.push(k),
      onLastRelease: (k) => releases.push(k),
    },
  };
}

test("createWatchRefCount fires onFirstAcquire only when the count transitions 0 → 1", () => {
  const { acquires, handlers } = makeSpyHandlers();
  const rc = createWatchRefCount(handlers);
  rc.acquire("/repo");
  rc.acquire("/repo");
  rc.acquire("/repo");
  assert.deepEqual(acquires, ["/repo"]);
  assert.equal(rc.peek("/repo"), 3);
});

test("createWatchRefCount fires onLastRelease only when the count transitions back to 0", () => {
  const { releases, handlers } = makeSpyHandlers();
  const rc = createWatchRefCount(handlers);
  rc.acquire("/repo");
  rc.acquire("/repo");
  rc.release("/repo");
  assert.deepEqual(releases, []);
  rc.release("/repo");
  assert.deepEqual(releases, ["/repo"]);
  assert.equal(rc.peek("/repo"), 0);
});

test("createWatchRefCount drops the key from its internal map after the last release so size() shrinks", () => {
  const { handlers } = makeSpyHandlers();
  const rc = createWatchRefCount(handlers);
  rc.acquire("/a");
  rc.acquire("/b");
  assert.equal(rc.size(), 2);
  rc.release("/a");
  assert.equal(rc.size(), 1);
  rc.release("/b");
  assert.equal(rc.size(), 0);
});

test("createWatchRefCount ignores empty-string keys for both acquire and release", () => {
  const { acquires, releases, handlers } = makeSpyHandlers();
  const rc = createWatchRefCount(handlers);
  rc.acquire("");
  rc.release("");
  assert.deepEqual(acquires, []);
  assert.deepEqual(releases, []);
  assert.equal(rc.size(), 0);
});

test("createWatchRefCount tolerates an over-release on an unknown key without firing onLastRelease", () => {
  const { releases, handlers } = makeSpyHandlers();
  const rc = createWatchRefCount(handlers);
  rc.release("/never-acquired");
  assert.deepEqual(releases, []);
  assert.equal(rc.peek("/never-acquired"), 0);
});

test("createWatchRefCount tracks distinct keys independently", () => {
  const { acquires, releases, handlers } = makeSpyHandlers();
  const rc = createWatchRefCount(handlers);
  rc.acquire("/a");
  rc.acquire("/b");
  rc.acquire("/a");
  rc.release("/a");
  rc.release("/b");
  assert.deepEqual(acquires, ["/a", "/b"]);
  assert.deepEqual(releases, ["/b"]);
  assert.equal(rc.peek("/a"), 1);
  assert.equal(rc.peek("/b"), 0);
});

test("normalizeRepoPath strips any number of trailing slashes", () => {
  assert.equal(normalizeRepoPath("/repo"), "/repo");
  assert.equal(normalizeRepoPath("/repo/"), "/repo");
  assert.equal(normalizeRepoPath("/repo////"), "/repo");
  assert.equal(normalizeRepoPath("/"), "/");
  assert.equal(normalizeRepoPath("////"), "/");
});

test("normalizeRepoPath preserves internal slashes", () => {
  assert.equal(normalizeRepoPath("/a/b/c"), "/a/b/c");
  assert.equal(normalizeRepoPath("/a//b//c"), "/a//b//c");
  assert.equal(normalizeRepoPath("/a/b "), "/a/b ");
});

test("sameRepoPath treats paths that differ only by trailing slashes as equal", () => {
  assert.equal(sameRepoPath("/repo", "/repo/"), true);
  assert.equal(sameRepoPath("/repo///", "/repo"), true);
});

test("sameRepoPath returns false for genuinely different paths even if a prefix matches", () => {
  assert.equal(sameRepoPath("/repo", "/repo2"), false);
  assert.equal(sameRepoPath("/repo/sub", "/repo"), false);
});

test("normalizeLocalRepoPath accepts local repo paths without accepting the home placeholder", () => {
  assert.equal(normalizeLocalRepoPath("/repo/"), "/repo");
  assert.equal(normalizeLocalRepoPath("/"), "/");
  assert.equal(normalizeLocalRepoPath("~/repo/"), "~/repo");
  assert.equal(normalizeLocalRepoPath("~"), null);
  assert.equal(normalizeLocalRepoPath("~other/repo"), null);
  assert.equal(normalizeLocalRepoPath("relative/repo"), null);
  assert.equal(normalizeLocalRepoPath("user@example.com"), null);
  assert.equal(normalizeLocalRepoPath(""), null);
  assert.equal(normalizeLocalRepoPath(undefined), null);
});
