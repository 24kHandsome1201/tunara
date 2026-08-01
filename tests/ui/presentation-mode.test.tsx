import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { usePresentationModeContextMenuGuard } from "@/app/usePresentationModeContextMenuGuard";
import { Titlebar } from "@/ui/Titlebar";
import { CommandPalette } from "@/ui/overlays/CommandPalette";

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
    <div
      data-testid="terminal-surface"
      onContextMenu={onContextMenu}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
    />
  );
}

test("pure mode suppresses contextmenu capture without blocking PTY mouse events", () => {
  useUIStore.setState({ presentationMode: "workspace", configLoaded: false });
  const onContextMenu = vi.fn();
  const onMouseDown = vi.fn();
  const onMouseUp = vi.fn();
  render(<ContextMenuGuardHarness onContextMenu={onContextMenu} onMouseDown={onMouseDown} onMouseUp={onMouseUp} />);
  const surface = screen.getByTestId("terminal-surface");

  const workspaceMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  surface.dispatchEvent(workspaceMenu);
  expect(workspaceMenu.defaultPrevented).toBe(false);
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  act(() => useUIStore.getState().setPresentationMode("pure"));
  const pureMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  surface.dispatchEvent(pureMenu);
  expect(pureMenu.defaultPrevented).toBe(true);
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  fireEvent.mouseDown(surface, { button: 2 });
  fireEvent.mouseUp(surface, { button: 2 });
  expect(onMouseDown).toHaveBeenCalledTimes(1);
  expect(onMouseUp).toHaveBeenCalledTimes(1);

  act(() => useUIStore.getState().setPresentationMode("workspace"));
  const restoredMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  surface.dispatchEvent(restoredMenu);
  expect(restoredMenu.defaultPrevented).toBe(false);
  expect(onContextMenu).toHaveBeenCalledTimes(2);
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
      promptId: "host-key-1",
      host: "example.com",
      port: 22,
      fingerprint: "SHA256:test",
      keyType: "ssh-ed25519",
      reason: "unknown",
    }],
    keyboardInteractivePrompts: [{
      promptId: "interactive-1",
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

test("Pure Mode Files button follows its setting while the command palette remains an alternate path", () => {
  useUIStore.setState({
    configLoaded: false,
    presentationMode: "pure",
    nativeFullscreen: false,
    showPureModeFilesButton: true,
    panelVisible: false,
    inspectorTab: "overview",
  });
  const view = renderTitlebar();

  fireEvent.click(screen.getByRole("button", { name: "Open Files in Pure Mode" }));
  expect(useUIStore.getState()).toMatchObject({ panelVisible: true, inspectorTab: "files" });

  act(() => useUIStore.getState().setShowPureModeFilesButton(false));
  expect(screen.queryByRole("button", { name: "Open Files in Pure Mode" })).toBeNull();
  view.unmount();

  useUIStore.setState({ overlay: "command-palette" });
  render(<CommandPalette onClose={() => useUIStore.getState().setOverlay(null)} />);
  expect(screen.getByText("Open Files in Pure Mode")).toBeTruthy();
  fireEvent.click(screen.getByText("Open Files in Pure Mode"));
  expect(useUIStore.getState()).toMatchObject({ panelVisible: true, inspectorTab: "files", presentationMode: "pure" });
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
