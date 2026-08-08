import { describe, expect, test } from "vitest";
import { resolveInspectorNavigation } from "@/ui/inspector-navigation";

describe("inspector navigation", () => {
  test("keeps everyday local tools visible and moves specialist tools into overflow", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: false,
      hasBinding: false,
    })).toEqual({
      all: ["overview", "changes", "files", "preview", "notes", "transfers", "diagnostics", "knownHosts"],
      primary: ["overview", "changes", "files", "preview"],
      secondary: ["notes", "transfers", "diagnostics", "knownHosts"],
    });
  });

  test("adds connection-specific tools only when the remote session can support them", () => {
    expect(resolveInspectorNavigation({
      filesOnly: false,
      isRemote: true,
      hasBinding: true,
    }).secondary).toEqual([
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

  test("preserves the dedicated files-only projection", () => {
    expect(resolveInspectorNavigation({
      filesOnly: true,
      isRemote: true,
      hasBinding: true,
    })).toEqual({ all: ["files"], primary: ["files"], secondary: [] });
  });
});
