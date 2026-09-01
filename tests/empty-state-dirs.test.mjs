import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyStateRecentDirs,
  nearbyReposNotInRecents,
} from "../src/modules/session/empty-state-dirs.ts";

test("empty-state recents reuse the command-palette formatter and cap", () => {
  const recents = emptyStateRecentDirs(["/Users/me/code/tunara", "/Users/me/code/tunara", "~/dev/app", ""], 3);
  assert.deepEqual(recents, [
    { dir: "/Users/me/code/tunara", label: "tunara" },
    { dir: "~/dev/app", label: "app" },
  ]);
});

test("nearby repos skip directories already shown as recents", () => {
  const recents = emptyStateRecentDirs(["/Users/me/code/tunara", "/Users/me/dev/notes/"], 3);
  const nearby = nearbyReposNotInRecents(recents, [
    { path: "/Users/me/code/tunara", name: "tunara", mtime: 30 },
    { path: "/Users/me/dev/notes", name: "notes", mtime: 20 },
    { path: "/Users/me/projects/widget", name: "widget", mtime: 10 },
    { path: "/Users/me/projects/other", name: "other", mtime: 5 },
  ], 1);
  assert.deepEqual(nearby, [
    { path: "/Users/me/projects/widget", name: "widget", mtime: 10 },
  ]);
});
