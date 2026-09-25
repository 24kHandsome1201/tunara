import { mockIPC } from "@tauri-apps/api/mocks";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Sidebar } from "../../src/ui/Sidebar";
import { useMultiplexerStatusPolling, useMultiplexerStatusStore } from "../../src/state/multiplexer-status";
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

test("store keeps one summary per multiplexer kind and ignores identical updates", () => {
  const { setSummary } = useMultiplexerStatusStore.getState();
  const summary = { blocked: 0, working: 0, running: 1, done: 0, focusedCwd: "/repo" };
  setSummary("tmux", summary);
  setSummary("herdr", { ...summary, blocked: 2, running: 0 });
  const before = useMultiplexerStatusStore.getState().summaries;
  setSummary("tmux", { ...summary });
  expect(useMultiplexerStatusStore.getState().summaries).toBe(before);
  expect(before).toEqual({ tmux: summary, herdr: { ...summary, blocked: 2, running: 0 } });
  setSummary("tmux", null);
  expect(useMultiplexerStatusStore.getState().summaries).toEqual({ herdr: { ...summary, blocked: 2, running: 0 } });
});

test("polling queries each active kind via multiplexer_status and clears inactive kinds", async () => {
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    if (cmd !== "multiplexer_status") return null;
    const kind = (args as { kind: string }).kind;
    calls.push(kind);
    return kind === "tmux" ? tmuxStatus : null;
  });
  useMultiplexerStatusStore.getState().setSummary("herdr", { blocked: 1, working: 0, running: 0, done: 0, focusedCwd: null });
  const { rerender, unmount } = renderHook(({ kinds }) => useMultiplexerStatusPolling(kinds), {
    initialProps: { kinds: ["tmux", "zellij", "tmux"] as ("herdr" | "tmux" | "zellij")[] },
  });
  await waitFor(() => expect(useMultiplexerStatusStore.getState().summaries.tmux).toEqual({
    blocked: 0, working: 0, running: 2, done: 0, focusedCwd: "/repo/web",
  }));
  expect(calls.sort()).toEqual(["tmux", "zellij"]);
  expect(useMultiplexerStatusStore.getState().summaries.herdr).toBeUndefined();
  expect(useMultiplexerStatusStore.getState().summaries.zellij).toBeUndefined();
  rerender({ kinds: [] });
  expect(useMultiplexerStatusStore.getState().summaries).toEqual({});
  unmount();
});

test("a status reply for another kind is ignored", async () => {
  mockIPC((cmd) => (cmd === "multiplexer_status" ? tmuxStatus : null));
  const { unmount } = renderHook(() => useMultiplexerStatusPolling(["zellij"]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(useMultiplexerStatusStore.getState().summaries).toEqual({});
  unmount();
});

test("local tmux chip shows foreground agents and the focused pane cwd", async () => {
  mockIPC((cmd, args) => (cmd === "multiplexer_status" && (args as { kind: string }).kind === "tmux" ? tmuxStatus : null));
  render(
    <Sidebar
      sessions={[localSession("tmux-local", { lastCommand: "tmux new -A -s work" })]}
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
