import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { CommandPalette } from "@/ui/overlays/CommandPalette";

afterEach(() => vi.restoreAllMocks());

test("palette arrows follow visible search rows and Enter executes the highlighted command", () => {
  const newTerminal = vi.spyOn(useSessionsStore.getState(), "newTerminalInDir").mockImplementation(() => {});
  useSessionsStore.setState({
    sessions: [{ id: "palette-session", title: "Terminal", dir: "/workspace", branch: "", runState: "idle", updatedAt: 1 }],
    activeSessionId: "palette-session",
    recentDirs: [],
    recentCommands: [],
  });
  useUIStore.setState({ commandUsage: {} });
  const onClose = vi.fn();
  render(<CommandPalette onClose={onClose} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "new" } });
  const rows = screen.getAllByRole("option");
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("New terminal"),
    "New terminal in folder…",
    expect.stringContaining("New terminal in current directory"),
    expect.stringContaining("New SSH connection"),
  ]);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true })).toBe(rows[2]);
  expect(input.getAttribute("aria-activedescendant")).toBe(rows[2].id);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true })).toBe(rows[3]);
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(screen.getByRole("option", { selected: true })).toBe(rows[2]);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(newTerminal).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(onClose).toHaveBeenCalledOnce();
});

test("palette navigation and Enter are safe with no search results", () => {
  const onClose = vi.fn();
  render(<CommandPalette onClose={onClose} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "no-such-command-xyz" } });
  for (const key of ["ArrowDown", "ArrowUp", "Enter"]) fireEvent.keyDown(input, { key });
  expect(screen.queryAllByRole("option")).toEqual([]);
  expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});
