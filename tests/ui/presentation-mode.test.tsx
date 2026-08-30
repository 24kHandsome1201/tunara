import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { usePresentationModeContextMenuGuard } from "@/app/usePresentationModeContextMenuGuard";
import { Titlebar } from "@/ui/Titlebar";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import type { Session } from "@/ui/types";

vi.mock("@/ui/lib/current-window", () => ({ tryGetCurrentWindow: () => null }));

function renderTitlebar() {
  return render(
    <Titlebar
      sessions={[]}
      activeSessionId=""
      panelVisible={false}
      sidebarVisible
      onToggleSidebar={() => {}}
      onTogglePanel={() => {}}
      onSelectSession={() => {}}
      onCloseSession={() => {}}
      onNewTerminal={() => {}}
      onNewTerminalInDirectory={() => {}}
      onOpenSettings={() => {}}
    />,
  );
}

function ContextMenuGuardHarness({
  onContextMenu,
  onMouseDown,
  onMouseUp,
}: {
  onContextMenu: () => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
}) {
  const pure = useUIStore((state) => state.presentationMode === "pure");
  usePresentationModeContextMenuGuard(pure);
  return (
    <div data-testid="workspace-chrome" onContextMenu={onContextMenu}>
      <div
        data-testid="terminal-surface"
        data-terminal-canvas
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
      />
      <div data-testid="file-tree-item" data-explorer-item />
      <textarea data-testid="editor" defaultValue="draft" />
      <a data-testid="link" href="https://example.com">example</a>
    </div>
  );
}

test("workspace mode suppresses native chrome menus without consuming component contextmenu events", () => {
  useUIStore.setState({ presentationMode: "workspace", configLoaded: false });
  const onContextMenu = vi.fn();
  const onMouseDown = vi.fn();
  const onMouseUp = vi.fn();
  render(<ContextMenuGuardHarness onContextMenu={onContextMenu} onMouseDown={onMouseDown} onMouseUp={onMouseUp} />);
  const surface = screen.getByTestId("terminal-surface");

  const chromeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  screen.getByTestId("workspace-chrome").dispatchEvent(chromeMenu);
  expect(chromeMenu.defaultPrevented).toBe(true);
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  const workspaceMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  surface.dispatchEvent(workspaceMenu);
  expect(workspaceMenu.defaultPrevented).toBe(true);
  expect(onContextMenu).toHaveBeenCalledTimes(2);

  const treeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  screen.getByTestId("file-tree-item").dispatchEvent(treeMenu);
  expect(treeMenu.defaultPrevented).toBe(true);
  expect(onContextMenu).toHaveBeenCalledTimes(3);

  for (const testId of ["editor", "link"]) {
    const nativeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    screen.getByTestId(testId).dispatchEvent(nativeMenu);
    expect(nativeMenu.defaultPrevented).toBe(false);
  }
  expect(onContextMenu).toHaveBeenCalledTimes(5);

  fireEvent.mouseDown(surface, { button: 2 });
  fireEvent.mouseUp(surface, { button: 2 });
  expect(onMouseDown).toHaveBeenCalledTimes(1);
  expect(onMouseUp).toHaveBeenCalledTimes(1);
});

test("pure mode suppresses only terminal contextmenu without blocking PTY mouse events", () => {
  useUIStore.setState({ presentationMode: "pure", configLoaded: false });
  const onContextMenu = vi.fn();
  const onMouseDown = vi.fn();
  const onMouseUp = vi.fn();
  render(<ContextMenuGuardHarness onContextMenu={onContextMenu} onMouseDown={onMouseDown} onMouseUp={onMouseUp} />);
  const surface = screen.getByTestId("terminal-surface");

  const pureMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  surface.dispatchEvent(pureMenu);
  expect(pureMenu.defaultPrevented).toBe(true);
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  const chromeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  screen.getByTestId("workspace-chrome").dispatchEvent(chromeMenu);
  expect(chromeMenu.defaultPrevented).toBe(false);

  fireEvent.mouseDown(surface, { button: 2 });
  fireEvent.mouseUp(surface, { button: 2 });
  expect(onMouseDown).toHaveBeenCalledTimes(1);
  expect(onMouseUp).toHaveBeenCalledTimes(1);
});

test("presentation mode is a reversible projection over workspace UI state", () => {
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "workspace",
    sidebarVisible: false,
    panelVisible: true,
    overlay: "settings",
  });

  useUIStore.getState().setPresentationMode("pure");
  expect(useUIStore.getState()).toMatchObject({
    presentationMode: "pure",
    sidebarVisible: false,
    panelVisible: true,
    overlay: null,
  });

  useUIStore.getState().togglePresentationMode();
  expect(useUIStore.getState()).toMatchObject({
    presentationMode: "workspace",
    sidebarVisible: false,
    panelVisible: true,
  });
});

test("opening SSH leaves Pure Mode while blocking SSH challenges remain available", () => {
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "pure",
    overlay: null,
    hostKeyPrompts: [{
      hopRole: "direct",
      promptId: "host-key-1",
      host: "example.com",
      port: 22,
      fingerprint: "SHA256:test",
      keyType: "ssh-ed25519",
      reason: "unknown",
    }],
    keyboardInteractivePrompts: [{
      hopRole: "direct",
      promptId: "interactive-1",
      origin: {
        user: "deploy", host: "example.com", port: 22, logicalSessionId: "presentation-session",
        hopRole: "direct", transportGeneration: "presentation-generation",
      },
      name: "Verification",
      instructions: "Enter the current code",
      prompts: [{ prompt: "Code: ", echo: false }],
    }],
  });

  useUIStore.getState().openSshConnect({ host: "example.com", port: 22, user: "deploy" });

  expect(useUIStore.getState()).toMatchObject({
    presentationMode: "workspace",
    overlay: "ssh",
    sshPrefill: { host: "example.com", port: 22, user: "deploy" },
  });
  expect(useUIStore.getState().hostKeyPrompts).toHaveLength(1);
  expect(useUIStore.getState().keyboardInteractivePrompts).toHaveLength(1);
  useUIStore.setState({ hostKeyPrompts: [], keyboardInteractivePrompts: [] });
});

test("the titlebar makes entering and leaving windowed pure mode equally discoverable", () => {
  useUIStore.setState({ configLoaded: false, presentationMode: "workspace", nativeFullscreen: false });
  renderTitlebar();

  const enter = screen.getByRole("button", { name: /Pure Mode.+P/ });
  expect(screen.getByText("Pure Mode")).toBeTruthy();
  fireEvent.click(enter);

  expect(useUIStore.getState().presentationMode).toBe("pure");
  const exit = screen.getByRole("button", { name: /Exit Pure Mode.+P/ });
  expect(screen.getByText("Exit Pure Mode")).toBeTruthy();
  fireEvent.click(exit);

  expect(useUIStore.getState().presentationMode).toBe("workspace");
  expect(screen.getByRole("button", { name: /Pure Mode.+P/ })).toBeTruthy();
});

test("native fullscreen teaches the exit shortcut, fades, and reveals again at the top edge", () => {
  vi.useFakeTimers();
  try {
    useUIStore.setState({ configLoaded: false, presentationMode: "pure", nativeFullscreen: true });
    const { container } = renderTitlebar();

    expect(screen.getByRole("button", { name: /Exit Pure Mode.+P/ })).toBeTruthy();

    act(() => vi.advanceTimersByTime(1200));
    const edgeExit = screen.getByRole("button", { name: /Exit Pure Mode.+P/ });
    expect(edgeExit.getAttribute("data-visible")).toBe("false");
    expect(edgeExit.style.top).toBe("-26px");

    fireEvent.pointerDown(edgeExit, { button: 0, pointerId: 3, clientX: 450, clientY: 1 });
    expect(edgeExit.getAttribute("data-visible")).toBe("true");
    fireEvent.pointerUp(edgeExit, { pointerId: 3, clientX: 450, clientY: 1 });
    act(() => vi.advanceTimersByTime(1200));
    edgeExit.blur();
    fireEvent.focus(edgeExit);
    expect(edgeExit.getAttribute("data-visible")).toBe("true");

    const pointerMove = new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientY: 2 });
    act(() => window.dispatchEvent(pointerMove));
    expect(pointerMove.defaultPrevented).toBe(false);
    const revealedExit = screen.getByRole("button", { name: /Exit Pure Mode.+P/ });
    expect(container.querySelector('[data-presentation-action="exit-fullscreen-pure"]')?.getAttribute("data-visible")).toBe("true");

    fireEvent.click(revealedExit);
    expect(useUIStore.getState().presentationMode).toBe("workspace");
  } finally {
    vi.useRealTimers();
  }
});

test("Pure Mode Files action remains available in the action strip and command palette", () => {
  useSessionsStore.setState({ activeSessionId: "pane-a" });
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "pure",
    nativeFullscreen: false,
    showPureModeFilesButton: true,
    panelVisible: false,
    inspectorTab: "changes",
  });
  const view = renderTitlebar();

  fireEvent.click(screen.getByRole("button", { name: "Open Files in Pure Mode" }));
  expect(useUIStore.getState()).toMatchObject({ panelVisible: true, inspectorTab: "files" });
  expect(useSessionsStore.getState().activeSessionId).toBe("pane-a");
  expect(useUIStore.getState().presentationMode).toBe("pure");

  act(() => useUIStore.getState().setShowPureModeFilesButton(false));
  expect(screen.queryByRole("button", { name: "Open Files in Pure Mode" })).toBeNull();
  fireEvent.click(screen.getByLabelText("More actions"));
  expect(screen.getByRole("menuitem", { name: "Files" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Safe Paste" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Copy" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Search" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Command Palette" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Safe Paste" })).toHaveLength(1);
  view.unmount();

  useUIStore.setState({ overlay: "command-palette" });
  render(<CommandPalette onClose={() => useUIStore.getState().setOverlay(null)} />);
  expect(screen.getByText("Open Files in Pure Mode")).toBeTruthy();
  fireEvent.click(screen.getByText("Open Files in Pure Mode"));
  expect(useUIStore.getState()).toMatchObject({ panelVisible: true, inspectorTab: "files", presentationMode: "pure" });
});

test("Pure Mode action strip is keyboard/AT reachable and exposes touch overflow", () => {
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "pure",
    nativeFullscreen: false,
    overlay: null,
    showPureModeFilesButton: true,
  });
  const { container } = renderTitlebar();
  const strip = screen.getByRole("toolbar", { name: "Pure Mode actions" });
  expect(strip.getAttribute("data-visible")).toBe("true");
  expect(screen.getByRole("button", { name: "Safe Paste" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Command Palette" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Exit Pure Mode.+P/ })).toBeTruthy();
  expect(container.querySelector("[data-touch-overflow]")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Command Palette" }));
  expect(useUIStore.getState()).toMatchObject({ presentationMode: "pure", overlay: "command-palette" });
});

test("a hidden Pure Mode action strip leaves the tab order", () => {
  vi.useFakeTimers();
  try {
    useUIStore.setState({ configLoaded: false, presentationMode: "pure", nativeFullscreen: false, overlay: null });
    const { container } = renderTitlebar();
    const strip = container.querySelector("[data-pure-action-strip]") as HTMLElement;
    expect(strip.getAttribute("data-visible")).toBe("true");
    act(() => vi.advanceTimersByTime(1400));
    expect(strip.getAttribute("data-visible")).toBe("false");
    expect(strip.hasAttribute("inert")).toBe(true);
    expect(strip.getAttribute("aria-hidden")).toBe("true");
  } finally {
    vi.useRealTimers();
  }
});

test("Pure Mode action strip consumes terminal context announcements without switching session", () => {
  const sessions: Session[] = [
    { id: "pane-a", title: "First", dir: "/tmp/a", branch: "", runState: "idle", updatedAt: 1 },
    { id: "pane-b", title: "Second", dir: "/tmp/b", branch: "", runState: "idle", updatedAt: 2 },
  ];
  useSessionsStore.setState({ sessions, activeSessionId: "pane-a" });
  useUIStore.setState({ configLoaded: false, presentationMode: "pure", nativeFullscreen: false });
  const view = render(
    <Titlebar
      sessions={sessions}
      activeSessionId="pane-a"
      panelVisible={false}
      sidebarVisible
      onToggleSidebar={() => {}}
      onTogglePanel={() => {}}
      onSelectSession={() => {}}
      onCloseSession={() => {}}
      onNewTerminal={() => {}}
      onNewTerminalInDirectory={() => {}}
      onOpenSettings={() => {}}
    />,
  );

  act(() => window.dispatchEvent(new CustomEvent("tunara:terminal-context-announcement", {
    detail: { reason: "keyboard-navigation", logicalSessionId: "pane-b", index: 2, total: 2 },
  })));

  const status = screen.getByRole("status");
  expect(status.textContent).toContain("Second");
  expect(status.textContent).toContain("2/2");
  expect(status.getAttribute("aria-live")).toBe("polite");
  expect(useSessionsStore.getState().activeSessionId).toBe("pane-a");
  expect(useUIStore.getState().presentationMode).toBe("pure");

  view.rerender(
    <Titlebar
      sessions={sessions}
      activeSessionId="pane-b"
      panelVisible={false}
      sidebarVisible
      onToggleSidebar={() => {}}
      onTogglePanel={() => {}}
      onSelectSession={() => {}}
      onCloseSession={() => {}}
      onNewTerminal={() => {}}
      onNewTerminalInDirectory={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  view.rerender(
    <Titlebar
      sessions={sessions}
      activeSessionId="pane-a"
      panelVisible={false}
      sidebarVisible
      onToggleSidebar={() => {}}
      onTogglePanel={() => {}}
      onSelectSession={() => {}}
      onCloseSession={() => {}}
      onNewTerminal={() => {}}
      onNewTerminalInDirectory={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).not.toContain("2/2");
});

test("the pure-mode exit button drags horizontally without turning the drag into an exit click", () => {
  useUIStore.setState({ configLoaded: false, presentationMode: "pure", nativeFullscreen: true });
  renderTitlebar();
  const exit = screen.getByRole("button", { name: /Exit Pure Mode.+P/ }) as HTMLButtonElement;
  Object.defineProperty(exit, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 390, right: 510, top: 8, bottom: 38, width: 120, height: 30, x: 390, y: 8, toJSON: () => ({}) }),
  });
  Object.defineProperties(exit, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => true },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });

  fireEvent.pointerDown(exit, { button: 0, pointerId: 7, clientX: 450 });
  fireEvent.pointerMove(exit, { pointerId: 7, clientX: 600 });
  fireEvent.pointerUp(exit, { pointerId: 7, clientX: 600 });
  expect(exit.style.translate).toBe("150px 0");

  fireEvent.click(exit);
  expect(useUIStore.getState().presentationMode).toBe("pure");

  fireEvent.pointerDown(exit, { button: 0, pointerId: 8, clientX: 600, clientY: 20 });
  fireEvent.pointerMove(exit, { pointerId: 8, clientX: 600, clientY: 40 });
  fireEvent.pointerUp(exit, { pointerId: 8, clientX: 600, clientY: 40 });
  fireEvent.click(exit);
  expect(useUIStore.getState().presentationMode).toBe("pure");

  fireEvent.pointerDown(exit, { button: 0, pointerId: 9, clientX: 600, clientY: 20 });
  fireEvent.pointerMove(exit, { pointerId: 9, clientX: 650, clientY: 20 });
  expect(exit.style.translate).toBe("200px 0");
  fireEvent.pointerCancel(exit, { pointerId: 9, clientX: 650, clientY: 20 });
  expect(exit.style.translate).toBe("150px 0");

  fireEvent.click(exit);
  expect(useUIStore.getState().presentationMode).toBe("workspace");
});

test("the pure-mode command palette is a focused exit path", () => {
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "pure",
    overlay: "command-palette",
  });
  render(<CommandPalette onClose={() => useUIStore.getState().setOverlay(null)} />);

  expect(screen.getByText("Exit Pure Mode")).toBeTruthy();
  expect(screen.queryByText("Settings")).toBeNull();
  expect(screen.queryByText("New terminal")).toBeNull();

  fireEvent.click(screen.getByText("Exit Pure Mode"));
  expect(useUIStore.getState()).toMatchObject({
    presentationMode: "workspace",
    overlay: null,
  });
});

test("workspace command palette keeps mouse-free terminal recovery actions", () => {
  const session: Session = {
    id: "palette-terminal",
    title: "Palette terminal",
    dir: "/tmp",
    branch: "",
    runState: "idle",
    updatedAt: 1,
  };
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "workspace",
    overlay: "command-palette",
  });

  render(<CommandPalette onClose={() => useUIStore.getState().setOverlay(null)} />);

  expect(screen.getByText("Copy terminal selection")).toBeTruthy();
  expect(screen.getByText("Safe Paste into terminal")).toBeTruthy();
  expect(screen.getByText("Open terminal shortcut menu")).toBeTruthy();
  expect(screen.getByText("New terminal")).toBeTruthy();
});

test("command palette executes a repeated Enter intent only once", () => {
  useSessionsStore.setState({ sessions: [], activeSessionId: null });
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "workspace",
    overlay: "command-palette",
  });
  const onClose = vi.fn();
  render(<CommandPalette onClose={onClose} />);

  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "New terminal" } });
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Enter" });
  fireEvent.keyDown(dialog, { key: "Enter" });

  expect(useSessionsStore.getState().sessions).toHaveLength(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});
