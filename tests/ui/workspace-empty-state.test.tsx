import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

vi.mock("@/ui/lib/platform", () => ({ isMac: true }));

import { WorkspaceEmptyState } from "@/ui/WorkspaceEmptyState";

const originalRecentDirs = useSessionsStore.getState().recentDirs;
const originalNewTerminalInDir = useSessionsStore.getState().newTerminalInDir;
const originalKeybindings = useUIStore.getState().keybindings;

function buttonContaining(label: string): HTMLButtonElement {
  const labelNode = screen.getByText(label);
  const button = labelNode.closest("button");
  if (!button) throw new Error(`No button contains ${label}`);
  return button;
}

describe("workspace launch panel", () => {
  beforeEach(() => {
    useSessionsStore.setState({
      recentDirs: ["/Users/demo/alpha", "/Users/demo/beta"],
    });
    useUIStore.setState({
      keybindings: { ...originalKeybindings, newTerminal: "Mod+T" },
    });
  });

  afterEach(() => {
    useSessionsStore.setState({
      recentDirs: originalRecentDirs,
      newTerminalInDir: originalNewTerminalInDir,
    });
    useUIStore.setState({ keybindings: originalKeybindings });
  });

  test("makes directory selection primary and explains the secondary entry points", () => {
    const onNewTerminal = vi.fn();
    const onNewTerminalInDirectory = vi.fn();
    const onOpenSsh = vi.fn();

    render(
      <WorkspaceEmptyState
        onNewTerminal={onNewTerminal}
        onNewTerminalInDirectory={onNewTerminalInDirectory}
        onOpenSsh={onOpenSsh}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons[0].textContent).toContain(t("sidebar.new_terminal_in_directory"));

    const newTerminalButton = buttonContaining(t("sidebar.new_terminal"));
    expect(newTerminalButton.textContent).toContain("~");
    expect(newTerminalButton.textContent).toContain("⌘T");

    const sshButton = buttonContaining(t("sidebar.new_ssh_connection"));
    expect(sshButton.textContent).toContain("SSH");

    fireEvent.click(buttons[0]);
    fireEvent.click(newTerminalButton);
    fireEvent.click(sshButton);

    expect(onNewTerminalInDirectory).toHaveBeenCalledOnce();
    expect(onNewTerminal).toHaveBeenCalledOnce();
    expect(onOpenSsh).toHaveBeenCalledOnce();
  });

  test("shows recent directories as full-path rows and reopens the selected directory", () => {
    const openRecent = vi.fn();
    useSessionsStore.setState({
      newTerminalInDir: (dir) => openRecent(dir),
    });

    render(
      <WorkspaceEmptyState
        onNewTerminal={() => {}}
        onNewTerminalInDirectory={() => {}}
        onOpenSsh={() => {}}
      />,
    );

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("/Users/demo/alpha")).toBeTruthy();
    expect(within(list).getByText("/Users/demo/beta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "alpha, /Users/demo/alpha" }));
    expect(openRecent).toHaveBeenCalledWith("/Users/demo/alpha");
  });

  test("keeps the recent section out of the tab order when there is no history", () => {
    useSessionsStore.setState({ recentDirs: [] });

    render(
      <WorkspaceEmptyState
        onNewTerminal={() => {}}
        onNewTerminalInDirectory={() => {}}
        onOpenSsh={() => {}}
      />,
    );

    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("heading", { name: t("app.empty.recent") })).toBeNull();
  });
});
