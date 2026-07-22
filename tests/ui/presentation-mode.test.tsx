import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { usePresentationModeContextMenuGuard } from "@/app/usePresentationModeContextMenuGuard";
import { Titlebar } from "@/ui/Titlebar";
import { CommandPalette } from "@/ui/overlays/CommandPalette";

vi.mock("@/ui/lib/current-window", () => ({ tryGetCurrentWindow: () => null }));

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

test("the workspace titlebar exposes a visible pure-mode entry that disappears after activation", () => {
  useUIStore.setState({ configLoaded: false, presentationMode: "workspace", nativeFullscreen: false });
  const { container } = render(
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

  const entry = screen.getByRole("button", { name: /Enter Pure Mode/ });
  expect(screen.getByText("Pure Mode")).toBeTruthy();
  expect(entry.getAttribute("title")).toMatch(/Enter Pure Mode.+P/);

  fireEvent.click(entry);

  expect(useUIStore.getState().presentationMode).toBe("pure");
  expect(screen.queryByRole("button", { name: /Enter Pure Mode/ })).toBeNull();
  expect(container.querySelector('[data-presentation-chrome="windowed"]')).toBeTruthy();
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
