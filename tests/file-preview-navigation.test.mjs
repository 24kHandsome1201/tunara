import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  filePreviewWillChange,
  nextFilePreview,
} from "../src/modules/editor/file-preview-navigation.ts";

test("clicking the current file closes it while another file replaces it", () => {
  assert.equal(nextFilePreview("/a.txt", "/a.txt"), null);
  assert.equal(nextFilePreview("/a.txt", "/b.txt"), "/b.txt");
  assert.equal(nextFilePreview(null, "/a.txt"), "/a.txt");
});

test("only an already-open preview that will unmount or change needs guarding", () => {
  assert.equal(filePreviewWillChange(null, null), false);
  assert.equal(filePreviewWillChange(null, "/a.txt"), false);
  assert.equal(filePreviewWillChange("/a.txt", "/a.txt"), false);
  assert.equal(filePreviewWillChange("/a.txt", null), true);
  assert.equal(filePreviewWillChange("/a.txt", "/b.txt"), true);
});

test("FileExplorer routes every user-driven preview replacement through one guard", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  assert.match(source, /const runPreviewReplacingAction = useCallback/);
  assert.match(source, /const closePreviewFromExplorer = useCallback/);
  assert.match(source, /function goUp\(\) \{\s*runPreviewReplacingAction/);
  assert.match(source, /function enterDir\(name: string\) \{\s*runPreviewReplacingAction/);
  assert.match(source, /function openSearchDir\(path: string\) \{\s*runPreviewReplacingAction/);
  assert.match(source, /function toggleFile[\s\S]*runPreviewReplacingAction\(\(\) => setExpandedFile\(next\)\)/);
  assert.match(source, /function toggleSearchFile[\s\S]*runPreviewReplacingAction\(\(\) => setExpandedFile\(next\)\)/);
  assert.match(source, /if \(event\.key === "Escape" && expandedFile\)[\s\S]*closePreviewFromExplorer\(\)/);
  assert.match(source, /if \(event\.key !== "Escape"[\s\S]*closePreviewFromExplorer\(\)/);
});

test("directory reload no longer unmounts the editor as an effect side effect", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  const listingEffect = source.slice(source.indexOf("if (baseDir === null)"), source.indexOf("const q = searchQuery.trim()"));
  assert.doesNotMatch(listingEffect, /setExpandedFile\(null\)/);
});

test("rootDir changes keep the absolute-path editor unless the session identity changed", async () => {
  const source = await readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8");
  const rootEffect = source.slice(source.indexOf("// Resolve the starting directory"), source.indexOf("if (baseDir === null)"));
  assert.match(rootEffect, /previousSessionIdRef\.current !== activeSessionId/);
  assert.match(rootEffect, /if \(sessionChanged\) setExpandedFile\(null\)/);
  assert.doesNotMatch(rootEffect, /\n\s*setExpandedFile\(null\);/);
});
