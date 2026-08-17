import assert from "node:assert/strict";
import test from "node:test";

import {
  isUsableDirEntryName,
  joinPath,
  parentPath,
  usableExplorerEntries,
} from "../src/ui/file-explorer/helpers.ts";

test("joinPath never turns an empty or slash name into a nested root", () => {
  assert.equal(joinPath("/", "home"), "/home");
  assert.equal(joinPath("/", ""), "/");
  assert.equal(joinPath("/", "/"), "/");
  assert.equal(joinPath("/", "."), "/");
  assert.equal(joinPath("/", ".."), "/");
  assert.equal(joinPath("/home", "alice"), "/home/alice");
});

test("parentPath stops at the filesystem root", () => {
  assert.equal(parentPath("/home/alice"), "/home");
  assert.equal(parentPath("/home"), "/");
  assert.equal(parentPath("/"), "/");
});

test("usableExplorerEntries drops names that would collide with the current path", () => {
  assert.equal(isUsableDirEntryName(""), false);
  assert.equal(isUsableDirEntryName("/"), false);
  assert.equal(isUsableDirEntryName("."), false);
  assert.equal(isUsableDirEntryName("home"), true);
  assert.deepEqual(
    usableExplorerEntries([
      { name: "" },
      { name: "/" },
      { name: "bin" },
      { name: ".." },
    ]).map((entry) => entry.name),
    ["bin"],
  );
});
