import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  knownRemoteExplorerRoot,
  remoteExplorerListingRoot,
  remoteExplorerSearchRoot,
} from "../src/ui/lib/file-explorer-root.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("remote explorer trusts an OSC 7 absolute cwd", () => {
  assert.equal(knownRemoteExplorerRoot("/tmp/project"), "/tmp/project");
  assert.equal(knownRemoteExplorerRoot("  /root  "), "/root");
});

test("remote explorer falls back to SFTP home for legacy labels", () => {
  assert.equal(knownRemoteExplorerRoot("root@example.com"), null);
  assert.equal(knownRemoteExplorerRoot("~"), null);
  assert.equal(knownRemoteExplorerRoot("C:\\Users\\dev"), null);
});

test("FileExplorer uses the known remote cwd as a start location, not the listing root", () => {
  const source = readFileSync(resolve(root, "src/ui/FileExplorer.tsx"), "utf8");
  assert.match(source, /const knownStart = knownRemoteExplorerRoot\(rootDir\)/);
  assert.match(source, /const listingRoot = remoteExplorerListingRoot\(\)/);
  assert.match(source, /setBaseDir\(listingRoot\)/);
  assert.match(source, /if \(knownStart\) setCurrentPath\(\(current\) => current \|\| knownStart\)/);
});

test("remote explorer listing root is the filesystem root", () => {
  assert.equal(remoteExplorerListingRoot(), "/");
});

test("remote explorer search stays under the current directory, not the whole host", () => {
  assert.equal(remoteExplorerSearchRoot("/home/alice/app", "/home/alice"), "/home/alice/app");
  assert.equal(remoteExplorerSearchRoot("/", "/home/alice"), "/home/alice");
  assert.equal(remoteExplorerSearchRoot("/", null), "/");
});
