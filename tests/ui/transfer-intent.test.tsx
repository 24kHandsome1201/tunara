import { describe, expect, it } from "vitest";
import { classifyTransferDrop, expandFolderTransfer, renamedSibling, resolveTransferConflicts } from "@/modules/ssh/transfer-intent";

const binding = { logicalSessionId: "logical", physicalPtyId: 7, transportGeneration: "generation" };

describe("folder transfer intents", () => {
  it("classifies local, remote, and folder drops", () => {
    expect(classifyTransferDrop({ localPaths: ["/tmp/a"] }).kind).toBe("upload");
    expect(classifyTransferDrop({ remotePaths: ["/a"] }).kind).toBe("download");
    expect(classifyTransferDrop({ localPaths: ["/tmp/a"], folder: true })).toMatchObject({ kind: "folder", direction: "upload" });
    expect(() => classifyTransferDrop({ localPaths: ["a"], remotePaths: ["b"] })).toThrow();
  });

  it("generates a distinct bounded rename", () => {
    const result = renamedSibling("/to/report.txt", new Set(["/to/report (1).txt"]), 64);
    expect(result).toBe("/to/report (2).txt");
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(64);
  });

  it("preserves directories and expands only files into queue requests", () => {
    const plan = expandFolderTransfer({
      manifest: { files: [{ path: "nested", kind: "dir", bytes: 0 }, { path: "nested/a.txt", kind: "file", bytes: 2 }], totalBytes: 2 },
      binding, direction: "upload", sourceRoot: "/from", destinationRoot: "/to", conflict: "replace",
    });
    expect(plan.directories).toEqual(["/to", "/to/nested"]);
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toMatchObject({ source: "/from/nested/a.txt", destination: "/to/nested/a.txt" });
  });

  it("applies a batch conflict policy without upgrading undecided items to replace", () => {
    const items = [{ destination: "/to/a" }, { destination: "/to/b" }, { destination: "/to/c" }];
    expect(resolveTransferConflicts(items, new Set(["/to/a", "/to/b", "/to/c"]), [
      { conflict: "rename", applyAll: true },
    ])).toEqual(items.map((item) => ({ ...item, conflict: "rename" })));
    expect(resolveTransferConflicts(items, new Set(["/to/a", "/to/b", "/to/c"]), [
      { conflict: "replace" }, { conflict: "skip" },
    ])).toEqual([{ destination: "/to/a", conflict: "replace" }]);
  });
});
