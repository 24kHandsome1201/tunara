import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("FileExplorer opens files in persistent workspace tabs", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  assert.match(source, /openResource\(resourceRefForSession\(owner, path\), "preview"\)/);
  assert.match(source, /else openFile\(node\.path\)/);
  assert.doesNotMatch(source, /expandedFile|setExpandedFile|runPreviewReplacingAction/);
});

test("directory navigation no longer owns or unmounts an editor", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import\([^)]*FilePreview|<FilePreview/);
  assert.match(source, /function goUp\(\) \{\s*setNavDir\("out"\)/);
  assert.match(source, /if \(isDir\) \{ setNavDir\("in"\); setCurrentPath\(node\.path\); \}/);
});
