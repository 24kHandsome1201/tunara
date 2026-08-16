import { describe, expect, it } from "vitest";
import {
  BATCH_DOWNLOAD_LIMITS,
  classifyTransferDrop,
  expandFolderTransfer,
  planBatchDownloads,
  renamedSibling,
  resolveTransferConflicts,
  safeDownloadLeaf,
} from "@/modules/ssh/transfer-intent";

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

  it("plans batch downloads with safe, distinct, non-overwriting names", () => {
    const requests = planBatchDownloads({
      sources: [
        { path: "/one/report.txt", name: "report.txt", size: 2 },
        { path: "/two/report.txt", name: "report.txt", size: 3 },
        { path: "/bad/name", name: "../bad:name", size: 4 },
      ],
      destinationRoot: "/home/alice/Downloads",
      existingNames: ["report.txt"],
      binding,
    });
    expect(requests.map(({ source, destination }) => [source, destination])).toEqual([
      ["/one/report.txt", "/home/alice/Downloads/report (1).txt"],
      ["/two/report.txt", "/home/alice/Downloads/report (2).txt"],
      ["/bad/name", "/home/alice/Downloads/__bad_name"],
    ]);
    expect(requests.every(({ direction, conflict }) => direction === "download" && conflict === "rename")).toBe(true);
    expect(requests.every(({ createParents }) => createParents === true)).toBe(true);
    expect(safeDownloadLeaf("CON", 1)).toBe("_CON");
  });

  it("honors tighter caller download limits", () => {
    expect(() => planBatchDownloads({
      sources: [
        { path: "/one/a.txt", name: "a.txt", size: 2 },
        { path: "/two/b.txt", name: "b.txt", size: 2 },
      ],
      destinationRoot: "/home/alice/Downloads", existingNames: [], binding,
      limits: { maxFiles: 1 },
    })).toThrow("file limit");
  });

  it("rejects batch plans beyond file and total resource limits", () => {
    expect(() => planBatchDownloads({
      sources: Array.from({ length: BATCH_DOWNLOAD_LIMITS.maxFiles + 1 }, (_, index) => ({ path: `/${index}`, name: `${index}`, size: 0 })),
      destinationRoot: "/home/alice/Downloads", existingNames: [], binding,
    })).toThrow("file limit");
    expect(() => planBatchDownloads({
      sources: Array.from({ length: 11 }, (_, index) => ({ path: `/${index}`, name: `${index}`, size: BATCH_DOWNLOAD_LIMITS.maxFileBytes })),
      destinationRoot: "/home/alice/Downloads", existingNames: [], binding,
    })).toThrow("total size limit");
  });
});
