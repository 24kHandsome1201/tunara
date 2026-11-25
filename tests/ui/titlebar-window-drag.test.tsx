import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Session } from "@/ui/types";

const win = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  startDragging: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@/ui/lib/current-window", () => ({ tryGetCurrentWindow: () => win }));

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
  const view = render(
    <Titlebar
      sessions={[session]}
      activeSessionId={session.id}
      panelVisible
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
  return view.container.querySelector<HTMLElement>(".tunara-titlebar")!;
}

describe("borderless titlebar window dragging", () => {
  beforeEach(() => {
    document.documentElement.dataset.chrome = "borderless";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete document.documentElement.dataset.chrome;
  });

  test("double-clicking empty titlebar space toggles maximize", () => {
    const titlebar = renderTitlebar();

    fireEvent.mouseDown(titlebar, { button: 0, detail: 1 });
    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.mouseDown(titlebar, { button: 0, detail: 2 });

    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.startDragging).not.toHaveBeenCalled();
  });

  test("a press starts the native drag only once the pointer moves", () => {
    const titlebar = renderTitlebar();

    fireEvent.mouseDown(titlebar, { button: 0, detail: 1, screenX: 100, screenY: 10 });
    fireEvent.mouseMove(window, { screenX: 101, screenY: 11 });
    expect(win.startDragging).not.toHaveBeenCalled();

    fireEvent.mouseMove(window, { screenX: 110, screenY: 10 });
    fireEvent.mouseMove(window, { screenX: 140, screenY: 10 });
    expect(win.startDragging).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).not.toHaveBeenCalled();
  });

  test("releasing without moving never starts a drag", () => {
    const titlebar = renderTitlebar();

    fireEvent.mouseDown(titlebar, { button: 0, detail: 1, screenX: 100, screenY: 10 });
    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.mouseMove(window, { screenX: 200, screenY: 10 });

    expect(win.startDragging).not.toHaveBeenCalled();
  });

  test("a press after clicking a control is not a titlebar double-click", () => {
    const titlebar = renderTitlebar();
    const newMenu = screen.getByRole("button", { name: "New…" });

    fireEvent.mouseDown(titlebar, { button: 0, detail: 1 });
    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.mouseDown(newMenu, { button: 0, detail: 1 });
    fireEvent.mouseUp(window, { button: 0 });
    fireEvent.mouseDown(titlebar, { button: 0, detail: 2 });

    expect(win.toggleMaximize).not.toHaveBeenCalled();
  });

  test("titlebar controls keep their own clicks", () => {
    renderTitlebar();
    const newMenu = screen.getByRole("button", { name: "New…" });

    fireEvent.mouseDown(newMenu, { button: 0, detail: 2 });
    fireEvent.mouseDown(newMenu, { button: 0, detail: 1, screenX: 0, screenY: 0 });
    fireEvent.mouseMove(window, { screenX: 50, screenY: 0 });

    expect(win.toggleMaximize).not.toHaveBeenCalled();
    expect(win.startDragging).not.toHaveBeenCalled();
  });
});
