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

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("button", { name: /Exit Pure Mode.+P/ })).toBeNull();

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
