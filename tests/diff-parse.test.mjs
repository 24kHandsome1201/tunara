import assert from "node:assert/strict";
import test from "node:test";

import { buildMiniDiffRows, collectHunkTexts } from "../src/ui/lib/diff-parse.ts";

const SAMPLE_PATCH = [
  "diff --git a/foo.txt b/foo.txt",
  "--- a/foo.txt",
  "+++ b/foo.txt",
  "@@ -1,3 +1,4 @@",
  " context line",
  "-old line",
  "+new line",
  "+brand new",
  "@@ -10,2 +11,2 @@",
  "-bye",
  "+hello",
].join("\n");

test("buildMiniDiffRows assigns hunkIndex=-1 to every line before the first hunk header", () => {
  const rows = buildMiniDiffRows(SAMPLE_PATCH);
  // diff --git, ---, +++ all precede the first @@
  const prelude = rows.filter((r) => r.hunkIndex < 0);
  assert.equal(prelude.length, 3);
  assert.ok(prelude.every((r) => !r.isHunk));
});

test("buildMiniDiffRows marks +/- lines correctly without flagging the +++ /--- file headers as adds or dels", () => {
  const rows = buildMiniDiffRows(SAMPLE_PATCH);
  const headerPlus = rows.find((r) => r.line === "+++ b/foo.txt");
  const headerMinus = rows.find((r) => r.line === "--- a/foo.txt");
  assert.equal(headerPlus.isAdd, false);
  assert.equal(headerMinus.isDel, false);

  const realAdds = rows.filter((r) => r.isAdd).map((r) => r.line);
  const realDels = rows.filter((r) => r.isDel).map((r) => r.line);
  assert.deepEqual(realAdds, ["+new line", "+brand new", "+hello"]);
  assert.deepEqual(realDels, ["-old line", "-bye"]);
});

test("buildMiniDiffRows increments hunkIndex by 1 for each new @@ header and keeps subsequent rows in that bucket", () => {
  const rows = buildMiniDiffRows(SAMPLE_PATCH);
  const hunkHeaders = rows.filter((r) => r.isHunk);
  assert.equal(hunkHeaders.length, 2);
  assert.equal(hunkHeaders[0].hunkIndex, 0);
  assert.equal(hunkHeaders[1].hunkIndex, 1);

  const firstHunkLines = rows.filter((r) => r.hunkIndex === 0 && !r.isHunk);
  assert.ok(firstHunkLines.some((r) => r.line === " context line"));
  assert.ok(firstHunkLines.some((r) => r.line === "+brand new"));
});

test("buildMiniDiffRows produces stable unique keys per row", () => {
  const rows = buildMiniDiffRows(SAMPLE_PATCH);
  const keys = rows.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("collectHunkTexts excludes prelude lines and joins each hunk into a single string", () => {
  const rows = buildMiniDiffRows(SAMPLE_PATCH);
  const hunks = collectHunkTexts(rows);
  assert.equal(hunks.length, 2);
  // The first hunk should contain its header and 4 body lines.
  assert.ok(hunks[0].startsWith("@@ -1,3 +1,4 @@"));
  assert.ok(hunks[0].includes(" context line"));
  assert.ok(hunks[0].includes("+brand new"));
  // Nothing from the prelude (file headers) should leak in.
  assert.ok(!hunks[0].includes("+++ b/foo.txt"));
  assert.ok(hunks[1].includes("+hello"));
});

test("collectHunkTexts returns an empty array when the patch has no @@ markers", () => {
  const rows = buildMiniDiffRows("just\nsome\nnoise");
  assert.deepEqual(collectHunkTexts(rows), []);
});

