import { mockIPC } from "@tauri-apps/api/mocks";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  registerWorkspaceFlush,
  requestSafeAppRelaunch,
} from "@/app/app-lifecycle";
import {
  confirmDirtyDraftDiscard,
  registerDirtyDraft,
} from "@/modules/editor/dirty-draft-guard";
import { useUIStore } from "@/state/ui";

afterEach(() => {
  useUIStore.setState({ configLoaded: false });
});

test("safe relaunch waits for dirty-draft confirmation and both persistence flushes", async () => {
  const events: string[] = [];
  mockIPC((command) => {
    if (command === "save_config") {
      events.push("config");
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: true, configError: null });
  registerWorkspaceFlush(async () => {
    events.push("workspace");
    return "saved";
  });
  const owner = Symbol("restart-draft");
  registerDirtyDraft({
    owner,
    sessionId: "restart-session",
    filePath: "/draft.txt",
    dirty: true,
    requestConfirmation: () => { events.push("confirm"); },
  });
  const relaunch = vi.fn(async () => { events.push("relaunch"); });
  const onStarting = vi.fn();
  const onFailure = vi.fn();

  expect(requestSafeAppRelaunch(relaunch, { onStarting, onFailure })).toBe(false);
  expect(events).toEqual(["confirm"]);
  expect(relaunch).not.toHaveBeenCalled();

  expect(confirmDirtyDraftDiscard(owner)).toBe(true);
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
  expect(onStarting).toHaveBeenCalledOnce();
  expect(onFailure).not.toHaveBeenCalled();
  expect(events).toEqual(["confirm", "workspace", "config", "relaunch"]);
});

test("safe relaunch fails closed when workspace persistence is blocked", async () => {
  mockIPC((command) => {
    if (command === "save_config") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: true, configError: null });
  registerWorkspaceFlush(async () => "blocked");
  const relaunch = vi.fn(async () => {});
  const onFailure = vi.fn();

  expect(requestSafeAppRelaunch(relaunch, { onStarting: () => {}, onFailure })).toBe(true);
  await waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
  expect(relaunch).not.toHaveBeenCalled();
});
