import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { knownRemoteExplorerRoot } from "../src/ui/lib/file-explorer-root.ts";

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

test("FileExplorer uses the known remote cwd before resolving home", () => {
  const source = readFileSync(resolve(root, "src/ui/FileExplorer.tsx"), "utf8");
  assert.match(source, /const knownRoot = knownRemoteExplorerRoot\(rootDir\)/);
  assert.match(source, /if \(knownRoot\) \{[\s\S]*setBaseDir\(knownRoot\);[\s\S]*setCurrentPath\(knownRoot\);[\s\S]*return;/);
});
