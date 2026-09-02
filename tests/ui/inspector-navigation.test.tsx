import { describe, expect, test } from "vitest";
import { INSPECTOR_OVERFLOW_SECTION, resolveInspectorNavigation } from "@/ui/inspector-navigation";

describe("inspector navigation", () => {
  test("exposes every local Inspector view in the compact switcher", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: false,
    })).toEqual({
      all: ["changes", "files", "preview"],
      primary: ["changes", "files", "preview"],
      secondary: [],
    });
  });

  test("adds connection-specific views only for remote sessions", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: true,
    }).primary).toEqual([
      "changes",
      "files",
      "preview",
      "transfers",
      "forwarding",
    ]);
  });

  test("keeps overflow section labels for grouping documentation", () => {
    expect(INSPECTOR_OVERFLOW_SECTION.preview).toBe("workspace");
    expect(INSPECTOR_OVERFLOW_SECTION.transfers).toBe("transfer");
    expect(INSPECTOR_OVERFLOW_SECTION.forwarding).toBe("ssh");
  });

  test("preserves a dedicated files-only projection for callers that request it", () => {
    expect(resolveInspectorNavigation({
      filesOnly: true,
      isRemote: true,
    })).toEqual({ all: ["files"], primary: ["files"], secondary: [] });
  });
});
