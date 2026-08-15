import assert from "node:assert/strict";
import test from "node:test";

import { dropDestinationFromListing } from "../src/modules/ssh/drop-target.ts";
import {
  emptyHostFilePrefs,
  hostFilePrefsKey,
  pushHostRecentPath,
  rememberHostDownloadDir,
  sanitizeHostFilePrefs,
  sanitizeHostFilePrefsMap,
  toggleHostFavoritePath,
} from "../src/modules/ssh/host-file-prefs.ts";
import { siblingPreviewPaths } from "../src/modules/editor/sibling-files.ts";
import { parseTabularPreview } from "../src/modules/editor/tabular-preview.ts";

test("host prefs keep bounded favorites, recents, and a local download dir", () => {
  const key = hostFilePrefsKey({ user: "Root", host: "De-Netcup", port: 22 });
  assert.equal(key, "root@de-netcup:22");
  let prefs = emptyHostFilePrefs();
  prefs = pushHostRecentPath(prefs, "/var/log");
  prefs = pushHostRecentPath(prefs, "/tmp");
  prefs = pushHostRecentPath(prefs, "/var/log");
  prefs = toggleHostFavoritePath(prefs, "/var/log");
  prefs = rememberHostDownloadDir(prefs, "/Users/me/Downloads");
  assert.deepEqual(prefs.recentPaths, ["/var/log", "/tmp"]);
  assert.deepEqual(prefs.favoritePaths, ["/var/log"]);
  assert.equal(prefs.lastDownloadDir, "/Users/me/Downloads");
  const dirty = sanitizeHostFilePrefsMap({
    [key]: {
      favoritePaths: ["/ok", "../escape", "/ok", "relative"],
      recentPaths: ["\0bad", "/tmp"],
      lastDownloadDir: "not-absolute",
      followTerminalCwd: false,
    },
    "__proto__": { favoritePaths: ["/x"] },
  });
  assert.equal(dirty[key].followTerminalCwd, false);
  assert.deepEqual(dirty[key].favoritePaths, ["/ok"]);
  assert.deepEqual(dirty[key].recentPaths, ["/tmp"]);
  assert.equal(dirty[key].lastDownloadDir, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(dirty, "__proto__"), false);
});

test("drop targeting uses the hovered directory or the file's parent", () => {
  const nodes = [
    { path: "/srv/app", parentPath: "/srv", kind: "dir" },
    { path: "/srv/app/readme.md", parentPath: "/srv/app", kind: "file" },
    { path: "/srv/app/logs", parentPath: "/srv/app", kind: "dir" },
  ];
  assert.deepEqual(dropDestinationFromListing({
    clientY: 40, listTop: 0, scrollTop: 0, inset: 8, rowHeight: 32, nodes, currentPath: "/srv",
  }), { path: "/srv/app", highlightPath: "/srv/app" });
  assert.deepEqual(dropDestinationFromListing({
    clientY: 50, listTop: 0, scrollTop: 0, inset: 8, rowHeight: 32, nodes, currentPath: "/srv",
  }), { path: "/srv/app", highlightPath: "/srv/app" });
  assert.deepEqual(dropDestinationFromListing({
    clientY: 90, listTop: 0, scrollTop: 0, inset: 8, rowHeight: 32, nodes, currentPath: "/srv",
  }), { path: "/srv/app/logs", highlightPath: "/srv/app/logs" });
});

test("sibling preview walks only regular files in listing order", () => {
  const files = siblingPreviewPaths("/repo/b.txt", [
    { name: "a.txt", kind: "file" },
    { name: "nested", kind: "dir" },
    { name: "b.txt", kind: "file" },
    { name: "c.txt", kind: "file" },
  ]);
  assert.equal(files.previous, "/repo/a.txt");
  assert.equal(files.next, "/repo/c.txt");
});

test("tabular preview stays text-only for json and csv", () => {
  const json = parseTabularPreview("users.json", JSON.stringify([{ id: 1, name: "<script>" }, { id: 2, name: "ok" }]));
  assert.equal(json?.kind, "json");
  assert.deepEqual(json?.columns, ["id", "name"]);
  assert.equal(json?.rows[0][1], "<script>");
  const csv = parseTabularPreview("dump.csv", "a,b\n1,\"quoted,value\"\n2,x");
  assert.equal(csv?.kind, "csv");
  assert.deepEqual(csv?.rows[0], ["1", "quoted,value"]);
  assert.equal(parseTabularPreview("notes.md", "a,b"), null);
});
