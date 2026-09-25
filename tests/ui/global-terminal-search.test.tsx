import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useSessionsStore } from "@/state/sessions";
import { registerTerminalActions } from "@/modules/terminal/lib/terminal-action-registry";
import type { TerminalCommandBlock } from "@/modules/terminal/lib/terminal-blocks";
import { GlobalTerminalSearch } from "@/ui/overlays/GlobalTerminalSearch";
import type { Session } from "@/ui/types";

const local: Session = { id: "local-1", title: "Local build", dir: "/project", branch: "main", runState: "idle", unread: false, updatedAt: 1 };
const remote: Session = {
  id: "ssh-1",
  title: "Prod box",
  dir: "/srv",
  branch: "",
  runState: "idle",
  unread: false,
  updatedAt: 2,
  remote: { host: "prod.example", user: "deploy", port: 22 },
} as Session;

function fakeTerminal(lines: string[]) {
  const scrollToLine = vi.fn();
  const select = vi.fn();
  const focus = vi.fn();
  const nullCell = {};
  const buffer = {
    length: lines.length,
    getNullCell: () => nullCell,
    getLine: (row: number) => {
      const text = lines[row];
      if (text === undefined) return undefined;
      return {
        translateToString: () => text,
        getCell: (column: number) => (column < text.length ? { getChars: () => text[column], getWidth: () => 1 } : undefined),
      };
    },
  };
  const terminal = { cols: 80, rows: 10, buffer: { normal: buffer, active: buffer }, scrollToLine, select, focus } as unknown as Terminal;
  return { terminal, scrollToLine, select, focus };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

test("searches every open terminal, groups by session and reveals the chosen match", async () => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  useSessionsStore.setState({ sessions: [local, remote], activeSessionId: local.id });
  const localTerm = fakeTerminal(["$ pnpm test", "FAIL src/a.test.ts", "ok"]);
  const remoteTerm = fakeTerminal(["deploy started", "tail: fail to open log"]);
  const blocks = [{ id: "b1", command: "pnpm test", startRow: 0, endRow: 2, startedAt: 0 }] as TerminalCommandBlock[];
  cleanups.push(registerTerminalActions(local.id, { terminal: localTerm.terminal, openSearch: vi.fn(), getBlocks: () => blocks }));
  cleanups.push(registerTerminalActions(remote.id, { terminal: remoteTerm.terminal, openSearch: vi.fn() }));
  const onClose = vi.fn();
  render(<GlobalTerminalSearch onClose={onClose} />);

  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "fail" } });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2 matches in 2 terminals"));
  const groups = screen.getAllByRole("group");
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["Local build", "Prod box"]);
  expect(groups[0].textContent).toContain("$ pnpm test");
  expect(groups[1].textContent).toContain("deploy@prod.example");

  fireEvent.click(screen.getByRole("button", { name: "Case sensitive" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 matches in 1 terminals"));
  fireEvent.click(screen.getByRole("button", { name: "Case sensitive" }));
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  act(() => {
    fireEvent.keyDown(input, { key: "Enter" });
  });
  expect(onClose).toHaveBeenCalledOnce();
  expect(useSessionsStore.getState().activeSessionId).toBe(remote.id);
  expect(remoteTerm.select).toHaveBeenCalledWith(6, 1, 4);
  expect(remoteTerm.scrollToLine).toHaveBeenCalledWith(0);
  expect(remoteTerm.focus).toHaveBeenCalled();
});

test("regex mode reports invalid patterns without searching", async () => {
  useSessionsStore.setState({ sessions: [local], activeSessionId: local.id });
  const localTerm = fakeTerminal(["exit 127"]);
  cleanups.push(registerTerminalActions(local.id, { terminal: localTerm.terminal, openSearch: vi.fn() }));
  render(<GlobalTerminalSearch onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "exit (" } });
  expect(screen.getByRole("status").textContent).toBe("Invalid regular expression");
  fireEvent.change(input, { target: { value: "exit \\d+" } });
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1 matches in 1 terminals"));
  fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
});
