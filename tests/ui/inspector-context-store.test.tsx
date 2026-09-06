import { beforeEach, describe, expect, test } from "vitest";
import { useUIStore } from "@/state/ui";

describe("Inspector selection store", () => {
  beforeEach(() => {
    useUIStore.setState({
      inspectorTab: "files",
      inspectorPreviewOpenedSessionIds: {},
    });
  });

  test("setInspectorTab changes selection without lock state", () => {
    useUIStore.getState().setInspectorTab("preview", { sessionId: "s-a" });
    expect(useUIStore.getState()).toMatchObject({
      inspectorTab: "preview",
      inspectorPreviewOpenedSessionIds: { "s-a": true },
    });
    expect("inspectorLocked" in useUIStore.getState()).toBe(false);
    expect("inspectorLockSessionId" in useUIStore.getState()).toBe(false);
    expect("syncInspectorLockForSession" in useUIStore.getState()).toBe(false);
  });

  test("sessionId only records preview visibility", () => {
    useUIStore.getState().setInspectorTab("changes", { sessionId: "s-a" });
    expect(useUIStore.getState()).toMatchObject({
      inspectorTab: "changes",
      inspectorPreviewOpenedSessionIds: {},
    });
    useUIStore.getState().setInspectorTab("preview");
    expect(useUIStore.getState().inspectorPreviewOpenedSessionIds).toEqual({});
  });
});
