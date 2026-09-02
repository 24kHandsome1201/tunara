import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { useNativeContextMenuGuard } from "@/app/useNativeContextMenuGuard";
import { useChromeFade } from "@/app/useChromeFade";
import { Titlebar } from "@/ui/Titlebar";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import type { Session } from "@/ui/types";
import { useSessionsStore } from "@/state/sessions";

vi.mock("@/ui/lib/current-window", () => ({ tryGetCurrentWindow: () => null }));

function ChromeFadeHarness() {
  const faded = useChromeFade();
  return (
    <div data-chrome-faded={faded ? "true" : undefined} className={faded ? "chrome-faded" : undefined}>
      <div className="tunara-titlebar" data-testid="titlebar">titlebar</div>
      <div className="tunara-sidebar" data-testid="sidebar">sidebar</div>
      <textarea data-testid="editor" defaultValue="draft" />
      <div
        data-testid="terminal-surface"
        data-terminal-canvas
        tabIndex={0}
        className="xterm"
      >
        terminal
      </div>
      <div className="tunara-panel" data-testid="panel">panel</div>
    </div>
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
  useNativeContextMenuGuard();
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

test("chrome root gets data-chrome-faded when the terminal is focused", () => {
  render(<ChromeFadeHarness />);
  const root = screen.getByTestId("titlebar").parentElement!;
  expect(root.getAttribute("data-chrome-faded")).toBeNull();

  act(() => {
    screen.getByTestId("terminal-surface").focus();
  });
  expect(root.getAttribute("data-chrome-faded")).toBe("true");
  expect(root.classList.contains("chrome-faded")).toBe(true);

  act(() => {
    fireEvent.pointerOver(screen.getByTestId("sidebar"));
  });
  expect(root.getAttribute("data-chrome-faded")).toBeNull();

  act(() => {
    fireEvent.pointerOut(screen.getByTestId("sidebar"), { relatedTarget: screen.getByTestId("terminal-surface") });
  });
  expect(root.getAttribute("data-chrome-faded")).toBe("true");

  act(() => {
    screen.getByTestId("editor").focus();
  });
  expect(root.getAttribute("data-chrome-faded")).toBeNull();
});

test("an open overlay restores chrome opacity", () => {
  render(<ChromeFadeHarness />);
  const root = screen.getByTestId("titlebar").parentElement!;
  act(() => {
    screen.getByTestId("terminal-surface").focus();
  });
  expect(root.getAttribute("data-chrome-faded")).toBe("true");

  act(() => {
    useUIStore.setState({ overlay: "command-palette" });
  });
  expect(root.getAttribute("data-chrome-faded")).toBeNull();

  act(() => {
    useUIStore.setState({ overlay: null });
  });
  expect(root.getAttribute("data-chrome-faded")).toBe("true");
});

test("native chrome menus are suppressed without consuming component contextmenu events", () => {
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

  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
  const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 2 });
  surface.dispatchEvent(down);
  surface.dispatchEvent(up);
  expect(down.defaultPrevented).toBe(false);
  expect(up.defaultPrevented).toBe(false);
  expect(onMouseDown).toHaveBeenCalledOnce();
  expect(onMouseUp).toHaveBeenCalledOnce();
});

test("opening SSH does not depend on a presentation-mode restore", () => {
  useUIStore.setState({ mainSurface: "terminal", overlay: null, sshPrefill: null });
  useUIStore.getState().openSshConnect({ user: "deploy", host: "example.com", port: 22 });
  expect(useUIStore.getState()).toMatchObject({
    overlay: "ssh",
    sshPrefill: { user: "deploy", host: "example.com", port: 22 },
  });
});

test("titlebar workspace menu no longer offers Pure Mode", () => {
  render(
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
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menuitem", { name: /Pure Mode/ })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
});

test("command palette keeps mouse-free terminal recovery actions", () => {
  const session: Session = {
    id: "palette-terminal",
    title: "Palette terminal",
    dir: "/tmp",
    branch: "",
    runState: "idle",
    updatedAt: 1,
  };
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  useUIStore.setState({ overlay: "command-palette" });
  render(<CommandPalette onClose={() => useUIStore.getState().setOverlay(null)} />);

  expect(screen.getByText("New terminal")).toBeTruthy();
  expect(screen.queryByText("Enter Pure Mode")).toBeNull();
  expect(screen.queryByText("Exit Pure Mode")).toBeNull();

  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "Copy terminal selection" } });
  expect(screen.getByText("Copy terminal selection")).toBeTruthy();
  fireEvent.change(input, { target: { value: "Safe Paste into terminal" } });
  expect(screen.getByText("Safe Paste into terminal")).toBeTruthy();
  fireEvent.change(input, { target: { value: "Open terminal shortcut menu" } });
  expect(screen.getByText("Open terminal shortcut menu")).toBeTruthy();
});
