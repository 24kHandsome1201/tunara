import { describe, expect, test } from "vitest";
import { resolveInspectorNavigation } from "@/ui/inspector-navigation";

describe("inspector navigation", () => {
  test("keeps Files and Changes primary and puts unavailable tools in overflow", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: false,
    })).toEqual({
      all: ["files", "changes", "preview"],
      primary: ["files", "changes"],
      secondary: ["preview"],
    });
  });

  test("shows contextual tools when available or currently selected", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: true,
      previewAvailable: true,
      hasInProgressTransfer: true,
    }).primary).toEqual([
      "files",
      "changes",
      "preview",
      "transfers",
    ]);
    expect(resolveInspectorNavigation({ filesOnly: false, isRemote: true, current: "forwarding" })).toEqual({
      all: ["files", "changes", "preview", "transfers", "forwarding"],
      primary: ["files", "changes", "forwarding"],
      secondary: ["preview", "transfers"],
    });
  });

  test("preserves a dedicated files-only projection for callers that request it", () => {
    expect(resolveInspectorNavigation({
      filesOnly: true,
      isRemote: true,
    })).toEqual({ all: ["files"], primary: ["files"], secondary: [] });
  });
});
