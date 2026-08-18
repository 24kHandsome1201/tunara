import assert from "node:assert/strict";
import test from "node:test";

import { mountedTreeRowIndexes } from "../src/ui/file-explorer/tree-virtual.ts";

test("tree virtualizer keeps the viewport and unique forced semantic rows", () => {
  assert.deepEqual(
    mountedTreeRowIndexes(10_000, { first: 992, last: 1_033 }, [0, 1_000, 9_999, 9_999, -1]),
    [0, ...Array.from({ length: 41 }, (_, index) => 992 + index), 9_999],
  );
});

test("tree virtualizer clamps ranges and rejects invalid forced indexes", () => {
  assert.deepEqual(mountedTreeRowIndexes(3, { first: -10, last: 99 }, [3, Number.NaN]), [0, 1, 2]);
  assert.deepEqual(mountedTreeRowIndexes(0, { first: 0, last: 1 }, [0]), []);
});
