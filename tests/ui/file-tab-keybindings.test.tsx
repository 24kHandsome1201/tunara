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
import { isReaderPaneId, readerPaneId } from "@/modules/session/split-layout";

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
  useUIStore.getState().openReader({
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

function bindReaderKeys() {
  useUIStore.setState({
    overlay: null,
    keybindings: {
      ...defaultKeybindingsForPlatform("linux"),
      closeSession: "Ctrl+W",
      selectTab1: "Ctrl+1",
      selectTab2: "Ctrl+2",
      selectTab3: "Ctrl+3",
      selectLastTab: "Ctrl+9",
    },
  });
}

describe("reader pane keybindings", () => {
  test("number keys select sidebar-order sessions, not files", () => {
    seedSessions([first, second], second.id);
    openFile(first.id, "a.txt");
    openFile(second.id, "b.txt");

    bindReaderKeys();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const listener = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as EventListener;

    dispatch(listener, ctrlEvent("1"));
    expect(useSessionsStore.getState().activeSessionId).toBe(first.id);

    dispatch(listener, ctrlEvent("2"));
    expect(useSessionsStore.getState().activeSessionId).toBe(second.id);

    dispatch(listener, ctrlEvent("9"));
    expect(useSessionsStore.getState().activeSessionId).toBe(second.id);
  });

  test("Mod+W closes a focused reader without closing the session", () => {
    seedSessions([first, second], first.id);
    openFile(first.id, "a.txt");
    useUIStore.getState().setFocusedPaneId(readerPaneId(first.id));
    bindReaderKeys();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const listener = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as EventListener;

    dispatch(listener, ctrlEvent("w"));
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([first.id, second.id]);
    expect(useUIStore.getState().split.root).toBeNull();
    expect(useUIStore.getState().readers[first.id]?.current?.fileName).toBe("a.txt");
    expect(isReaderPaneId(useUIStore.getState().focusedPaneId ?? "")).toBe(false);
  });

  test("dirty reader close waits for discard confirmation", () => {
    seedSessions([first], first.id);
    openFile(first.id, "dirty.txt");
    useUIStore.getState().setFocusedPaneId(readerPaneId(first.id));
    const owner = Symbol("dirty");
    let confirmations = 0;
    registerDirtyDraft({
      owner,
      sessionId: first.id,
      filePath: "/tmp/project/dirty.txt",
      dirty: true,
      requestConfirmation: () => { confirmations += 1; },
    });
    bindReaderKeys();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const listener = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as EventListener;

    dispatch(listener, ctrlEvent("w"));
    expect(confirmations).toBe(1);
    expect(useUIStore.getState().split.root).not.toBeNull();

    expect(cancelDirtyDraftAction(owner)).toBe(true);
    dispatch(listener, ctrlEvent("w"));
    expect(confirmations).toBe(2);
    expect(confirmDirtyDraftDiscard(owner)).toBe(true);
    expect(useUIStore.getState().split.root).toBeNull();
    expect(useSessionsStore.getState().sessions[0].id).toBe(first.id);
  });

  test("without a focused reader, close still targets the session", () => {
    seedSessions([first, second], first.id);
    bindReaderKeys();
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const listener = addEventListener.mock.calls.find(([type]) => type === "keydown")?.[1] as EventListener;
    dispatch(listener, ctrlEvent("w"));
    expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual([second.id]);
  });
});
