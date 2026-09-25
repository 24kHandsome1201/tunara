import { mockIPC } from "@tauri-apps/api/mocks";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Sidebar } from "../../src/ui/Sidebar";
import { useMultiplexerStatusPolling, useMultiplexerStatusStore, type MultiplexerPollTarget } from "../../src/state/multiplexer-status";
import type { Session } from "../../src/ui/types";

const tmuxStatus = {
  kind: "tmux",
  panes: [
    { paneId: "%1", sessionId: "$0", windowId: "@0", focused: false, agent: "claude", agentStatus: "running", cwd: "/repo" },
    { paneId: "%2", sessionId: "$0", windowId: "@0", focused: true, agent: null, agentStatus: "unknown", cwd: "/repo/web" },
    { paneId: "%3", sessionId: "$0", windowId: "@1", focused: false, agent: "codex", agentStatus: "running", cwd: "/repo" },
  ],
};

function localSession(id: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, dir: "/repo", branch: "", runState: "running", updatedAt: 1, ...patch };
}

beforeEach(() => {
  useMultiplexerStatusStore.setState({ summaries: {} });
});

test("store keeps one summary per Tunara session and ignores identical updates", () => {
  const { setSummary } = useMultiplexerStatusStore.getState();
  const summary = { blocked: 0, working: 0, running: 1, done: 0, focusedCwd: "/repo" };
  setSummary("tab-a", summary);
  setSummary("tab-b", { ...summary, running: 0, focusedCwd: "/other" });
  const before = useMultiplexerStatusStore.getState().summaries;
  setSummary("tab-a", { ...summary });
  expect(useMultiplexerStatusStore.getState().summaries).toBe(before);
  setSummary("tab-a", null);
  expect(useMultiplexerStatusStore.getState().summaries).toEqual({ "tab-b": { ...summary, running: 0, focusedCwd: "/other" } });
});

test("polling queries each tab with its own pty/session target and clears tabs no longer polled", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "multiplexer_status") return null;
    calls.push(args);
    const { kind, ptyId } = args as { kind: string; ptyId: number | null };
    return kind === "tmux" && ptyId === 7 ? tmuxStatus : null;
  });
  useMultiplexerStatusStore.getState().setSummary("stale", { blocked: 1, working: 0, running: 0, done: 0, focusedCwd: null });
  const { rerender, unmount } = renderHook(({ targets }) => useMultiplexerStatusPolling(targets), {
    initialProps: { targets: [
      { sessionId: "tab-a", kind: "tmux", ptyId: 7 },
      { sessionId: "tab-b", kind: "tmux", ptyId: 8 },
      { sessionId: "tab-z", kind: "zellij", ptyId: 9, sessionName: "work" },
    ] as MultiplexerPollTarget[] },
  });
  await waitFor(() => expect(useMultiplexerStatusStore.getState().summaries["tab-a"]).toEqual({
    blocked: 0, working: 0, running: 2, done: 0, focusedCwd: "/repo/web",
  }));
  expect(calls).toEqual(expect.arrayContaining([
    { kind: "tmux", ptyId: 7, sessionName: null },
    { kind: "tmux", ptyId: 8, sessionName: null },
    { kind: "zellij", ptyId: 9, sessionName: "work" },
  ]));
  const { summaries } = useMultiplexerStatusStore.getState();
  expect(summaries["tab-b"]).toBeUndefined();
  expect(summaries.stale).toBeUndefined();
  rerender({ targets: [] });
  expect(useMultiplexerStatusStore.getState().summaries).toEqual({});
  unmount();
});

test("a status reply for another kind is ignored", async () => {
  mockIPC((cmd) => (cmd === "multiplexer_status" ? tmuxStatus : null));
  const { unmount } = renderHook(() => useMultiplexerStatusPolling([{ sessionId: "z", kind: "zellij" }]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(useMultiplexerStatusStore.getState().summaries).toEqual({});
  unmount();
});

test("separate local tmux tabs get their own summaries", async () => {
  mockIPC((cmd, args) => (cmd === "multiplexer_status" && (args as { ptyId: number }).ptyId === 1 ? tmuxStatus : null));
  render(
    <Sidebar
      sessions={[
        localSession("tmux-a", { lastCommand: "tmux new -A -s work", ptyId: 1 }),
        localSession("tmux-b", { lastCommand: "tmux new -A -s play", ptyId: 2 }),
      ]}
      activeSessionId="tmux-a"
      onSelectSession={vi.fn()}
    />,
  );
  expect(await screen.findByText("tmux · 2 Agent")).toBeTruthy();
  expect(screen.getAllByText("tmux")).toHaveLength(1);
});

test("zellij tabs pass the session name from the terminal title", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => { if (cmd === "multiplexer_status") calls.push(args); return null; });
  render(
    <Sidebar
      sessions={[localSession("zj", { lastCommand: "zellij", shellTitle: "calm-river | vim", ptyId: 4 })]}
      activeSessionId="zj"
      onSelectSession={vi.fn()}
    />,
  );
  await waitFor(() => expect(calls).toEqual([{ kind: "zellij", ptyId: 4, sessionName: "calm-river" }]));
});

test("local tmux chip shows foreground agents and the focused pane cwd", async () => {
  mockIPC((cmd, args) => (cmd === "multiplexer_status" && (args as { kind: string }).kind === "tmux" ? tmuxStatus : null));
  render(
    <Sidebar
      sessions={[localSession("tmux-local", { lastCommand: "tmux new -A -s work", ptyId: 1 })]}
      activeSessionId="tmux-local"
      onSelectSession={vi.fn()}
    />,
  );
  const chip = await screen.findByText("tmux · 2 Agent");
  expect(chip.getAttribute("data-multiplexer")).toBe("tmux");
  expect(chip.getAttribute("data-herdr-blocked")).toBeNull();
  expect(chip.getAttribute("title")).toBe(
    "tmux panes: 2 with an Agent in the foreground (status inside the Agent is not visible). Focused pane: /repo/web",
  );
});

test("remote tmux sessions are not polled", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => { if (cmd === "multiplexer_status") calls.push(args); return null; });
  render(
    <Sidebar
      sessions={[localSession("tmux-remote", { lastCommand: "tmux", remote: { host: "box", port: 22, user: "u", authMethod: "agent" } })]}
      activeSessionId="tmux-remote"
      onSelectSession={vi.fn()}
    />,
  );
  expect(screen.getByText("tmux")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toEqual([]);
});
