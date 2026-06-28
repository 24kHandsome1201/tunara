import assert from "node:assert/strict";
import test from "node:test";

import { groupGrepHitsByFile } from "../src/modules/fs/lib/grep-group.ts";

test("groupGrepHitsByFile groups hits by file preserving first-seen file order", () => {
  const hits = [
    { path: "/r/src/a.ts", rel: "src/a.ts", line: 3, text: "foo" },
    { path: "/r/README.md", rel: "README.md", line: 1, text: "foo" },
    { path: "/r/src/a.ts", rel: "src/a.ts", line: 9, text: "bar" },
  ];
  const groups = groupGrepHitsByFile(hits);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].path, "/r/src/a.ts");
  assert.equal(groups[0].rel, "src/a.ts");
  assert.equal(groups[0].lines.length, 2);
  assert.equal(groups[0].lines[0].line, 3);
  assert.equal(groups[0].lines[0].text, "foo");
  assert.equal(groups[0].lines[1].line, 9);
  assert.equal(groups[1].path, "/r/README.md");
  assert.equal(groups[1].lines[0].text, "foo");
});

test("groupGrepHitsByFile returns empty for empty input", () => {
  assert.deepEqual(groupGrepHitsByFile([]), []);
});

test("groupGrepHitsByFile keeps per-file line order from input (no re-sort)", () => {
  // Backend emits ascending lines within a file, but the function must not
  // re-sort — it preserves whatever order it receives.
  const hits = [
    { path: "/r/a.ts", rel: "a.ts", line: 9, text: "z" },
    { path: "/r/a.ts", rel: "a.ts", line: 3, text: "a" },
  ];
  const groups = groupGrepHitsByFile(hits);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lines[0].line, 9);
  assert.equal(groups[0].lines[1].line, 3);
});

test("groupGrepHitsByFile rel comes from the first hit for that file", () => {
  const hits = [
    { path: "/r/x.ts", rel: "x.ts", line: 1, text: "a" },
    { path: "/r/x.ts", rel: "x.ts", line: 2, text: "b" },
  ];
  const groups = groupGrepHitsByFile(hits);
  assert.equal(groups[0].rel, "x.ts");
  assert.equal(groups[0].lines.length, 2);
});
