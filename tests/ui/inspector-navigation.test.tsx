import { describe, expect, test } from "vitest";
import { INSPECTOR_OVERFLOW_SECTION, resolveInspectorNavigation } from "@/ui/inspector-navigation";

describe("inspector navigation", () => {
  test("keeps everyday local tools visible and moves specialist tools into overflow", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: false,
    })).toEqual({
      all: ["overview", "changes", "files", "preview", "notes"],
      primary: ["overview", "changes", "files"],
      secondary: ["preview", "notes"],
    });
  });

  test("adds connection-specific tools only for remote sessions", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: true,
    }).secondary).toEqual([
      "preview",
      "notes",
      "transfers",
      "forwarding",
    ]);
  });

  test("groups overflow tools into workspace, transfer, and SSH sections", () => {
    expect(INSPECTOR_OVERFLOW_SECTION.preview).toBe("workspace");
    expect(INSPECTOR_OVERFLOW_SECTION.notes).toBe("workspace");
    expect(INSPECTOR_OVERFLOW_SECTION.transfers).toBe("transfer");
    expect(INSPECTOR_OVERFLOW_SECTION.forwarding).toBe("ssh");
  });

  test("promotes Preview into the primary tabs when a source is live", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: false,
      hasPreviewSource: true,
    })).toEqual({
      all: ["overview", "changes", "files", "preview", "notes"],
      primary: ["overview", "changes", "files", "preview"],
      secondary: ["notes"],
    });
  });

  test("preserves the dedicated files-only projection", () => {
    expect(resolveInspectorNavigation({
      filesOnly: true,
      isRemote: true,
    })).toEqual({ all: ["files"], primary: ["files"], secondary: [] });
  });
});
