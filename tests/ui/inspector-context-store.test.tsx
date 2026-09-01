import { beforeEach, describe, expect, test } from "vitest";
import { useUIStore } from "@/state/ui";

describe("Inspector lock store", () => {
  beforeEach(() => {
    useUIStore.setState({
      inspectorTab: "files",
      inspectorLocked: false,
      inspectorLockSessionId: null,
      inspectorPreviewOpenedSessionIds: {},
    });
  });

  test("manual setInspectorTab locks the current session until unlock or session switch", () => {
    useUIStore.getState().setInspectorTab("preview", { sessionId: "s-a" });
    expect(useUIStore.getState()).toMatchObject({
      inspectorTab: "preview",
      inspectorLocked: true,
      inspectorLockSessionId: "s-a",
    });

    useUIStore.getState().syncInspectorLockForSession("s-a");
    expect(useUIStore.getState().inspectorLocked).toBe(true);

    useUIStore.getState().syncInspectorLockForSession("s-b");
    expect(useUIStore.getState()).toMatchObject({
      inspectorLocked: false,
      inspectorLockSessionId: null,
      inspectorTab: "preview",
    });
  });

  test("auto setInspectorTab can follow without locking", () => {
    useUIStore.getState().setInspectorTab("changes", { lock: false, sessionId: "s-a" });
    expect(useUIStore.getState()).toMatchObject({
      inspectorTab: "changes",
      inspectorLocked: false,
      inspectorLockSessionId: null,
    });
  });

  test("session-less lock binds to the next Inspector session", () => {
    useUIStore.getState().setInspectorTab("files");
    expect(useUIStore.getState()).toMatchObject({
      inspectorLocked: true,
      inspectorLockSessionId: null,
    });
    useUIStore.getState().syncInspectorLockForSession("s-a");
    expect(useUIStore.getState()).toMatchObject({
      inspectorLocked: true,
      inspectorLockSessionId: "s-a",
    });
  });
});
