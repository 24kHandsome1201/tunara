import { expect, test } from "vitest";
import { splitToolbarOverflow } from "@/ui/lib/toolbar-overflow";

test("keeps every item visible when they fit without an overflow control", () => {
  expect(splitToolbarOverflow(["a", "b", "c"], [40, 40, 40], 200, 36, 2)).toEqual({
    visible: ["a", "b", "c"],
    overflow: [],
  });
});

test("moves trailing items into overflow once the row would exceed the available width", () => {
  expect(splitToolbarOverflow(["a", "b", "c", "d"], [50, 50, 50, 50], 160, 36, 2)).toEqual({
    visible: ["a", "b"],
    overflow: ["c", "d"],
  });
});

test("reserves the overflow control when extra overflow-only items exist", () => {
  expect(splitToolbarOverflow(["a", "b", "c"], [50, 50, 50], 160, 36, 2, true)).toEqual({
    visible: ["a", "b"],
    overflow: ["c"],
  });
});

test("collapses the whole row when even one item plus the overflow control cannot fit", () => {
  expect(splitToolbarOverflow(["a", "b"], [80, 80], 30, 36, 2)).toEqual({
    visible: [],
    overflow: ["a", "b"],
  });
});
