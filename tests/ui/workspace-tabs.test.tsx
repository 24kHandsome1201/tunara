import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Session } from "@/ui/types";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import {
  cancelDirtyDraftAction,
  confirmDirtyDraftDiscard,
  registerDirtyDraft,
  requestDirtyDraftFileAction,
} from "@/modules/editor/dirty-draft-guard";
import { readerPaneId } from "@/modules/session/split-layout";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/ui/lib/current-window", () => ({ tryGetCurrentWindow: () => null }));
vi.mock("@/ui/TerminalView", () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-${sessionId}`} />,
}));
vi.mock("@/ui/FilePreview", () => ({
  FilePreview: ({ fileName }: { fileName: string }) => <div data-testid={`file-${fileName}`} />,
}));
vi.mock("@/ui/useSessionGitContext", () => ({ useSessionGitContext: () => null }));
vi.mock("@/ui/useWorkspaceHydration", () => ({ useWorkspaceHydration: () => {} }));

import { MainArea } from "@/ui/MainArea";
import { Titlebar } from "@/ui/Titlebar";

const session: Session = {
  id: "terminal-1",
  title: "Terminal",
  dir: "/tmp/project",
  branch: "main",
  runState: "idle",
  updatedAt: 1,
};

function renderTitlebar(options?: {
  sessions?: Session[];
  activeSessionId?: string;
  sidebarVisible?: boolean;
}) {
  const sessions = options?.sessions ?? [session];
  return render(
    <Titlebar
      sessions={sessions}
      activeSessionId={options?.activeSessionId ?? sessions[0]?.id ?? session.id}
      panelVisible
      sidebarVisible={options?.sidebarVisible ?? true}
      onToggleSidebar={() => {}}
      onTogglePanel={() => {}}
      onSelectSession={(id) => useSessionsStore.getState().setActive(id)}
      onCloseSession={() => {}}
      onNewTerminal={() => {}}
      onNewTerminalInDirectory={() => {}}
      onOpenSettings={() => {}}
    />,
  );
}

function openReader(sessionId: string, filePath: string, fileName: string) {
  return useUIStore.getState().openReader({ sessionId, filePath, fileName });
}

describe("workspace reader pane and titlebar chrome", () => {
  test("removes the sidebar affordance when an empty workspace has no sidebar content", () => {
    renderTitlebar({ sessions: [], activeSessionId: "", sidebarVisible: false });

    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    expect(screen.getByRole("button", { name: "New…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });

  test("keeps local, folder, and SSH launch modes in one compact titlebar menu", () => {
    renderTitlebar({ sidebarVisible: false });

    expect(screen.queryByRole("button", { name: "New terminal in folder…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New…" }));
    expect(screen.getByRole("menuitem", { name: "New terminal" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "New terminal in folder…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "New SSH connection" })).toBeTruthy();
  });

  test("opens a reader beside the terminal instead of covering it", async () => {
    useSessionsStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      launchedSessionIds: { [session.id]: true },
    });
    const view = render(<MainArea sessions={[session]} activeSessionId={session.id} />);
    const terminal = screen.getByTestId(`terminal-${session.id}`);

    await act(async () => {
      openReader(session.id, "/tmp/project/notes.txt", "notes.txt");
    });
    expect(await screen.findByTestId("file-notes.txt")).toBeTruthy();
    expect(screen.getByTestId(`terminal-${session.id}`)).toBe(terminal);
    expect(useUIStore.getState().split.root).toMatchObject({ type: "split", direction: "horizontal", ratio: 0.4 });
    expect(terminal.closest("[data-terminal-session-id]")?.parentElement?.style.display).not.toBe("none");
    view.unmount();
  });

  test("closing the reader restores a full-width terminal and keeps history", async () => {
    useSessionsStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      launchedSessionIds: { [session.id]: true },
    });
    render(<MainArea sessions={[session]} activeSessionId={session.id} />);
    act(() => { openReader(session.id, "/tmp/project/notes.txt", "notes.txt"); });
    expect(await screen.findByTestId("file-notes.txt")).toBeTruthy();

    act(() => { useUIStore.getState().closeReaderPane(session.id); });
    expect(useUIStore.getState().split.root).toBeNull();
    expect(useUIStore.getState().readers[session.id]?.current?.fileName).toBe("notes.txt");
    expect(screen.getByTestId(`terminal-${session.id}`)).toBeTruthy();
  });

  test("dirty reader close stays on the file until discard is confirmed", () => {
    useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
    openReader(session.id, "/tmp/project/notes.txt", "notes.txt");
    useUIStore.getState().setReaderDirty(session.id, true);
    let confirmations = 0;
    const owner = Symbol("notes");
    registerDirtyDraft({
      owner,
      sessionId: session.id,
      filePath: "/tmp/project/notes.txt",
      dirty: true,
      requestConfirmation: () => { confirmations += 1; },
    });

    const run = () => useUIStore.getState().closeReaderPane(session.id);
    expect(requestDirtyDraftFileAction(session.id, "/tmp/project/notes.txt", run)).toBe(false);
    expect(confirmations).toBe(1);
    expect(useUIStore.getState().split.root).not.toBeNull();

    expect(cancelDirtyDraftAction(owner)).toBe(true);
    expect(confirmDirtyDraftDiscard(owner)).toBe(false);
    expect(requestDirtyDraftFileAction(session.id, "/tmp/project/notes.txt", run)).toBe(false);
    expect(confirmDirtyDraftDiscard(owner)).toBe(true);
    expect(useUIStore.getState().split.root).toBeNull();
  });

  test("replacing the current file of an open reader does not add another pane", () => {
    useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
    expect(openReader(session.id, "/tmp/project/a.txt", "a.txt")).toBe(true);
    expect(openReader(session.id, "/tmp/project/b.txt", "b.txt")).toBe(true);
    expect(useUIStore.getState().readers[session.id]?.current?.fileName).toBe("b.txt");
    expect(useUIStore.getState().readers[session.id]?.history.map((entry) => entry.fileName)).toEqual(["a.txt", "b.txt"]);
    const root = useUIStore.getState().split.root;
    expect(root && root.type === "split" ? root.second : null).toMatchObject({ type: "reader", sessionId: session.id });
  });

  test("a fourth pane blocks a new reader with a toast path returning false", () => {
    const extra: Session[] = [
      session,
      { ...session, id: "t2" },
      { ...session, id: "t3" },
      { ...session, id: "t4" },
    ];
    useSessionsStore.setState({ sessions: extra, activeSessionId: session.id });
    const ui = useUIStore.getState();
    ui.splitPane(session.id, "t2", "horizontal");
    ui.splitPane(session.id, "t3", "vertical");
    ui.splitPane("t2", "t4", "vertical");
    expect(openReader(session.id, "/tmp/project/notes.txt", "notes.txt")).toBe(false);
    expect(useUIStore.getState().readers[session.id]).toBeUndefined();
  });

  test("titlebar shows the current device caption without file tabs", () => {
    const remoteSession: Session = {
      ...session,
      id: "ssh-only",
      title: "Pi",
      dir: "/srv",
      remote: { host: "pi", port: 22, user: "tuna" },
      connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
    };
    useSessionsStore.setState({ sessions: [remoteSession], activeSessionId: remoteSession.id });
    renderTitlebar({ sessions: [remoteSession], activeSessionId: remoteSession.id, sidebarVisible: true });

    const identity = screen.getByRole("status", { name: /tuna@pi/ });
    expect(identity.getAttribute("data-titlebar-device-kind")).toBe("ssh");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "New…" })).toBeTruthy();
  });

  test("closing a session drops its reader", () => {
    useSessionsStore.setState({
      sessions: [session, { ...session, id: "terminal-2", title: "Second" }],
      activeSessionId: session.id,
    });
    openReader(session.id, "/tmp/project/only.txt", "only.txt");
    expect(useUIStore.getState().readers[session.id]?.current?.fileName).toBe("only.txt");
    act(() => { useSessionsStore.getState().closeSession(session.id); });
    expect(useUIStore.getState().readers[session.id]).toBeUndefined();
    expect(useUIStore.getState().focusedPaneId).not.toBe(readerPaneId(session.id));
  });
});
