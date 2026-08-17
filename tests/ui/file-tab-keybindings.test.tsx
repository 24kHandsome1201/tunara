import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useKeybindings } from "@/app/useKeybindings";
import {
  cancelDirtyDraftAction,
  confirmDirtyDraftDiscard,
  registerDirtyDraft,
} from "@/modules/editor/dirty-draft-guard";
import { defaultKeybindingsForPlatform } from "@/modules/config/keybindings";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";
import {
  handleFileSurfaceClose,
  handleFileSurfaceCycle,
  handleFileSurfaceSelectIndex,
  handleFileSurfaceSelectLast,
} from "@/ui/lib/workspace-tab-actions";

const first: Session = {
  id: "terminal-1",
  title: "One",
  dir: "/tmp/project",
  branch: "main",
  runState: "idle",
  updatedAt: 1,
};

const second: Session = {
  ...first,
  id: "terminal-2",
  title: "Two",
};

function seedSessions(sessions: Session[], activeId = sessions[0]?.id ?? null) {
  useSessionsStore.setState({
    sessions,
    activeSessionId: activeId,
    launchedSessionIds: Object.fromEntries(sessions.map((session) => [session.id, true])),
  });
}

function openFile(sessionId: string, fileName: string) {
  useUIStore.getState().openFileTab({
    sessionId,
    filePath: `/tmp/project/${fileName}`,
    fileName,
  });
}

function Harness() {
  useKeybindings();
  return null;
}

function dispatch(listener: EventListener, event: KeyboardEvent) {
  listener(event);
  return event;
}

function ctrlEvent(key: string, extra: { shiftKey?: boolean } = {}) {
  return {
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: Boolean(extra.shiftKey),
    target: null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

function bindFileSurfaceKeys() {
  useUIStore.setState({
    overlay: null,
    keybindings: {
      ...defaultKeybindingsForPlatform("linux"),
      closeSession: "Ctrl+W",
      selectTab1: "Ctrl+1",
      selectTab2: "Ctrl+2",
      selectTab3: "Ctrl+3",
      selectLastTab: "Ctrl+9",
      cycleNextSession: "Ctrl+Tab",
      cyclePrevSession: "Ctrl+Shift+Tab",
    },
  });
}

describe("file surface keybindings", () => {
  test("close and number keys target file tabs instead of sessions", () => {
    seedSessions([first, second], second.id);
    openFile(first.id, "a.txt");
    openFile(second.id, "b.txt");
    expect(useUIStore.getState().fileTabs.map((tab) => tab.fileName)).toEqual(["a.txt", "b.txt"]);

    expect(handleFileSurfaceSelectIndex(0)).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBe(`${first.id}\0/tmp/project/a.txt`);
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);

    expect(handleFileSurfaceSelectIndex(1)).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBe(`${second.id}\0/tmp/project/b.txt`);

    expect(handleFileSurfaceSelectIndex(2)).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBe(`${second.id}\0/tmp/project/b.txt`);
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([first.id, second.id]);

    expect(handleFileSurfaceSelectLast()).toBe(true);
    const tabs = useUIStore.getState().fileTabs;
    expect(tabs[tabs.length - 1]?.fileName).toBe("b.txt");

    expect(handleFileSurfaceClose()).toBe(true);
    expect(useUIStore.getState().fileTabs.map((tab) => tab.fileName)).toEqual(["a.txt"]);
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([first.id, second.id]);
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);

    expect(handleFileSurfaceClose()).toBe(true);
    expect(useUIStore.getState()).toMatchObject({ fileTabs: [], activeFileTabId: null });
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);
    expect(handleFileSurfaceClose()).toBe(false);
  });

  test("cycles from a file back to a terminal without closing the tab", () => {
    seedSessions([first, second], second.id);
    openFile(second.id, "notes.txt");

    expect(handleFileSurfaceCycle("next")).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBeNull();
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);
    expect(useUIStore.getState().fileTabs).toHaveLength(1);

    useUIStore.getState().setActiveFileTab(useUIStore.getState().fileTabs[0].id);
    expect(handleFileSurfaceCycle("prev")).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBeNull();
    expect(useSessionsStore.getState().activeSessionId).toBe(second.id);
  });

  test("dirty file close stays on the file until discard is confirmed", () => {
    seedSessions([first], first.id);
    openFile(first.id, "dirty.txt");
    const owner = Symbol("dirty");
    let confirmations = 0;
    registerDirtyDraft({
      owner,
      sessionId: first.id,
      filePath: "/tmp/project/dirty.txt",
      dirty: true,
      requestConfirmation: () => { confirmations += 1; },
    });

    expect(handleFileSurfaceClose()).toBe(true);
    expect(confirmations).toBe(1);
    expect(useUIStore.getState().fileTabs).toHaveLength(1);
    expect(useSessionsStore.getState().sessions).toHaveLength(1);

    expect(cancelDirtyDraftAction(owner)).toBe(true);
    expect(handleFileSurfaceClose()).toBe(true);
    expect(confirmDirtyDraftDiscard(owner)).toBe(true);
    expect(useUIStore.getState()).toMatchObject({ fileTabs: [], activeFileTabId: null });
    expect(useSessionsStore.getState().sessions[0].id).toBe(first.id);
  });

  test("app bindings close and switch files from capture-phase chords", () => {
    seedSessions([first, second], first.id);
    openFile(first.id, "a.txt");
    openFile(second.id, "b.txt");
    bindFileSurfaceKeys();

    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const listener = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as EventListener;
    expect(listener).toBeTypeOf("function");

    dispatch(listener, ctrlEvent("1"));
    expect(useUIStore.getState().activeFileTabId).toBe(`${first.id}\0/tmp/project/a.txt`);
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);

    dispatch(listener, ctrlEvent("2"));
    expect(useUIStore.getState().activeFileTabId).toBe(`${second.id}\0/tmp/project/b.txt`);

    dispatch(listener, ctrlEvent("3"));
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([first.id, second.id]);
    expect(useUIStore.getState().activeFileTabId).toBe(`${second.id}\0/tmp/project/b.txt`);

    dispatch(listener, ctrlEvent("Tab"));
    expect(useUIStore.getState().activeFileTabId).toBeNull();
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);
    expect(useUIStore.getState().fileTabs).toHaveLength(2);

    useUIStore.getState().setActiveFileTab(useUIStore.getState().fileTabs[1].id);
    dispatch(listener, ctrlEvent("w"));
    expect(useUIStore.getState().fileTabs.map((tab) => tab.fileName)).toEqual(["a.txt"]);
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([first.id, second.id]);
  });

  test("without a file surface, close still targets the session", () => {
    seedSessions([first, second], first.id);
    expect(handleFileSurfaceClose()).toBe(false);
    bindFileSurfaceKeys();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const listener = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as EventListener;
    dispatch(listener, ctrlEvent("w"));
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([second.id]);
  });

  test("number keys stay inside the current device working set", () => {
    const remote: Session = {
      ...first,
      id: "ssh-1",
      title: "Pi",
      dir: "/srv",
      remote: { host: "pi", port: 22, user: "tuna" },
    };
    seedSessions([first, remote], remote.id);
    openFile(first.id, "a.txt");
    useUIStore.getState().openFileTab({
      sessionId: remote.id,
      filePath: "/srv/b.txt",
      fileName: "b.txt",
    });

    expect(handleFileSurfaceSelectIndex(0)).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBe(`${remote.id}\0/srv/b.txt`);
    expect(handleFileSurfaceSelectIndex(1)).toBe(true);
    expect(useUIStore.getState().activeFileTabId).toBe(`${remote.id}\0/srv/b.txt`);
    expect(useSessionsStore.getState().activeSessionId).toBe(remote.id);
  });
});
