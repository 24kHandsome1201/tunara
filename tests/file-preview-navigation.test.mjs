import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("FileExplorer opens files in persistent workspace tabs", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  assert.match(source, /useUIStore\.getState\(\)\.openFileTab\(\{ sessionId, filePath: path, fileName \}\)/);
  assert.match(source, /onClick=\{\(\) => openFile\(fullPath\)\}/);
  assert.doesNotMatch(source, /expandedFile|setExpandedFile|runPreviewReplacingAction/);
});

test("directory navigation no longer owns or unmounts an editor", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import\([^)]*FilePreview|<FilePreview/);
  assert.match(source, /function goUp\(\) \{\s*setNavDir\("out"\)/);
  assert.match(source, /function enterDir\(name: string\) \{\s*setNavDir\("in"\)/);
});
