import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { Session } from "@/ui/types";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { registerDirtyDraft } from "@/modules/editor/dirty-draft-guard";

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

function renderTitlebar() {
  return render(
    <Titlebar
      sessions={[session]}
      activeSessionId={session.id}
      panelVisible
      sidebarVisible
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

describe("workspace file and terminal tabs", () => {
  test("uses distinct tab types, switches surfaces, and shows file dirty state", () => {
    useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
    useUIStore.getState().openFileTab({
      sessionId: session.id,
      filePath: "/tmp/project/notes.txt",
      fileName: "notes.txt",
    });
    const fileTabId = useUIStore.getState().activeFileTabId!;
    useUIStore.getState().setFileTabDirty(fileTabId, true);
    renderTitlebar();

    const terminalTab = screen.getByRole("tab", { name: "Terminal" });
    const fileTab = screen.getByRole("tab", { name: /notes\.txt/ });
    expect(terminalTab.closest("[data-workspace-tab-kind]")?.getAttribute("data-workspace-tab-kind")).toBe("terminal");
    expect(fileTab.closest("[data-workspace-tab-kind]")?.getAttribute("data-workspace-tab-kind")).toBe("file");
    expect(fileTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Unsaved")).toBeTruthy();

    fireEvent.click(terminalTab);
    expect(useUIStore.getState().activeFileTabId).toBeNull();
    expect(terminalTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(fileTab);
    expect(useUIStore.getState().activeFileTabId).toBe(fileTabId);
  });

  test("routes a dirty file close through its editor-owned confirmation", () => {
    useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
    useUIStore.getState().openFileTab({ sessionId: session.id, filePath: "/tmp/project/notes.txt", fileName: "notes.txt" });
    const fileTabId = useUIStore.getState().activeFileTabId!;
    useUIStore.getState().setFileTabDirty(fileTabId, true);
    let confirmations = 0;
    registerDirtyDraft({
      owner: Symbol("notes"),
      sessionId: session.id,
      filePath: "/tmp/project/notes.txt",
      dirty: true,
      requestConfirmation: () => { confirmations += 1; },
    });
    renderTitlebar();

    fireEvent.click(screen.getByRole("button", { name: "Close notes.txt" }));
    expect(confirmations).toBe(1);
    expect(useUIStore.getState().fileTabs).toHaveLength(1);
  });

  test("closing an active file selects the adjacent file's owning session", () => {
    const secondSession = { ...session, id: "terminal-2", title: "Second" };
    useSessionsStore.setState({ sessions: [session, secondSession], activeSessionId: secondSession.id });
    useUIStore.getState().openFileTab({ sessionId: session.id, filePath: "/tmp/project/a.txt", fileName: "a.txt" });
    useUIStore.getState().openFileTab({ sessionId: secondSession.id, filePath: "/tmp/project/b.txt", fileName: "b.txt" });
    render(
      <Titlebar
        sessions={[session, secondSession]}
        activeSessionId={secondSession.id}
        panelVisible
        sidebarVisible
        onToggleSidebar={() => {}}
        onTogglePanel={() => {}}
        onSelectSession={(id) => useSessionsStore.getState().setActive(id)}
        onCloseSession={() => {}}
        onNewTerminal={() => {}}
        onNewTerminalInDirectory={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close b.txt" }));
    expect(useSessionsStore.getState().activeSessionId).toBe(session.id);
    expect(useUIStore.getState()).toMatchObject({
      activeFileTabId: `${session.id}\0/tmp/project/a.txt`,
      fileTabs: [{ fileName: "a.txt" }],
    });
  });

  test("keeps the terminal component mounted while a file surface is active", async () => {
    useSessionsStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      launchedSessionIds: { [session.id]: true },
    });
    const view = render(<MainArea sessions={[session]} activeSessionId={session.id} />);
    const terminal = screen.getByTestId(`terminal-${session.id}`);

    await act(async () => {
      useUIStore.getState().openFileTab({ sessionId: session.id, filePath: "/tmp/project/notes.txt", fileName: "notes.txt" });
    });
    expect(await screen.findByTestId("file-notes.txt")).toBeTruthy();
    expect(screen.getByTestId(`terminal-${session.id}`)).toBe(terminal);
    expect(terminal.closest("[data-terminal-session-id]")?.parentElement?.style.display).toBe("none");

    act(() => useUIStore.getState().activateTerminal());
    expect(screen.getByTestId(`terminal-${session.id}`)).toBe(terminal);
    expect(terminal.closest("[data-terminal-session-id]")?.parentElement?.style.display).toBe("flex");
    view.unmount();
  });

  test("Pure Mode hides the file surface without forgetting its selected tab", () => {
    useUIStore.getState().openFileTab({ sessionId: session.id, filePath: "/tmp/project/notes.txt", fileName: "notes.txt" });
    const fileTabId = useUIStore.getState().activeFileTabId;
    useUIStore.getState().setPresentationMode("pure");
    expect(useUIStore.getState().activeFileTabId).toBe(fileTabId);
    useUIStore.getState().setPresentationMode("workspace");
    expect(useUIStore.getState().activeFileTabId).toBe(fileTabId);
  });

  test("opens a busy SSH file in a new remote sibling rooted at its directory", () => {
    const remote = { host: "dev.example", port: 22, user: "tuna", identityFile: "~/.ssh/id_ed25519" };
    const busyRemote: Session = {
      ...session,
      id: "remote-1",
      dir: "/srv/project",
      runState: "running",
      remote,
    };
    useSessionsStore.setState({ sessions: [busyRemote], activeSessionId: busyRemote.id });

    act(() => useSessionsStore.getState().openFileInTerminal(
      busyRemote.id,
      "/srv/project/notebooks",
      "a;echo 'pwn'.ipynb",
    ));

    const sessions = useSessionsStore.getState().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0].pendingInput).toBeUndefined();
    expect(sessions[1]).toMatchObject({
      dir: "/srv/project/notebooks",
      remote,
      pendingInput: "less -- 'a;echo '\"'\"'pwn'\"'\"'.ipynb'",
      pendingInputSubmit: true,
    });
  });

  test("reuses an idle SSH terminal and safely enters the file directory", () => {
    const remote = { host: "dev.example", port: 22, user: "tuna" };
    const idleRemote: Session = {
      ...session,
      id: "remote-idle",
      dir: "/srv/project",
      remote,
    };
    useSessionsStore.setState({ sessions: [idleRemote], activeSessionId: idleRemote.id });

    act(() => useSessionsStore.getState().openFileInTerminal(
      idleRemote.id,
      "/srv/project/a; $(touch PWNED)",
      "notes 'final'.txt",
    ));

    expect(useSessionsStore.getState().sessions).toHaveLength(1);
    expect(useSessionsStore.getState().sessions[0]).toMatchObject({
      pendingInput: "cd '/srv/project/a; $(touch PWNED)' && less -- 'notes '\"'\"'final'\"'\"'.txt'",
      pendingInputSubmit: true,
    });
  });
});
