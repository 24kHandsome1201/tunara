import { describe, expect, test } from "vitest";
import { INSPECTOR_OVERFLOW_SECTION, resolveInspectorNavigation } from "@/ui/inspector-navigation";

describe("inspector navigation", () => {
  test("keeps everyday local tools visible and moves specialist tools into overflow", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: false,
      hasBinding: false,
    })).toEqual({
      all: ["overview", "changes", "files", "preview", "notes"],
      primary: ["overview", "changes", "files"],
      secondary: ["preview", "notes"],
    });
  });

  test("adds connection-specific tools only when the remote session can support them", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: true,
      hasBinding: true,
    }).secondary).toEqual([
      "preview",
      "notes",
      "transfers",
      "metadata",
      "forwarding",
      "diagnostics",
      "knownHosts",
    ]);

    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: true,
      hasBinding: false,
    }).secondary).not.toContain("metadata");
  });

  test("groups overflow tools into workspace, transfer, and SSH sections", () => {
    expect(INSPECTOR_OVERFLOW_SECTION.preview).toBe("workspace");
    expect(INSPECTOR_OVERFLOW_SECTION.notes).toBe("workspace");
    expect(INSPECTOR_OVERFLOW_SECTION.transfers).toBe("transfer");
    expect(INSPECTOR_OVERFLOW_SECTION.diagnostics).toBe("ssh");
  });

  test("preserves the dedicated files-only projection", () => {
    expect(resolveInspectorNavigation({
      filesOnly: true,
      isRemote: true,
      hasBinding: true,
    })).toEqual({ all: ["files"], primary: ["files"], secondary: [] });
  });
});
