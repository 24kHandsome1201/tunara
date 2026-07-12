import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { PreviewPanel } from "@/ui/PreviewPanel";
import type { PreviewSource } from "@/modules/preview/preview-source";
import type { Session } from "@/ui/types";

function source(overrides: Partial<PreviewSource> = {}): PreviewSource {
  return {
    repositoryId: "repo-a",
    worktreeId: "worktree-a",
    workspaceId: "repo-a::worktree-a",
    sessionId: "session-a",
    terminalId: "session-a:0",
    sourceUrl: "http://127.0.0.1:41731/",
    discoveredAt: 1,
    transport: "local",
    workspaceResolution: "resolved",
    permission: "eligible",
    state: "active",
    ...overrides,
  };
}

function session(previewSources: PreviewSource[]): Session {
  return {
    id: "session-a",
    title: "Preview test",
    dir: "/repo/a",
    branch: "main",
    runState: "idle",
    previewSources,
    updatedAt: 1,
  };
}

test("renders the full source identity and opens only an eligible source", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "preview_open") return "preview-test";
    throw new Error(`unexpected command: ${command}`);
  });
  const eligible = source();
  render(<PreviewPanel session={session([eligible])} />);

  expect(screen.getByText("repo-a")).toBeTruthy();
  expect(screen.getByText("worktree-a")).toBeTruthy();
  expect(screen.getByText("session-a:0")).toBeTruthy();
  expect(screen.getByText(eligible.sourceUrl)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Preview" }));
  await waitFor(() => expect(calls).toContainEqual({ command: "preview_open", payload: { source: eligible } }));
  expect(screen.getByRole("button", { name: "Focus Preview" })).toBeTruthy();
});

test("keeps SSH, stale, and fallback sources visibly blocked", () => {
  render(<PreviewPanel session={session([
    source({ terminalId: "session-a:1", transport: "ssh", permission: "remote-manual" }),
    source({ terminalId: "session-a:2", state: "stale", staleReason: "terminal-exited" }),
    source({ terminalId: "session-a:3", workspaceResolution: "fallback" }),
  ])} />);

  expect(screen.getByText("SSH manual only")).toBeTruthy();
  expect(screen.getByText("Source is stale")).toBeTruthy();
  expect(screen.getByText("Workspace identity unresolved")).toBeTruthy();
  for (const button of screen.getAllByRole("button", { name: "Open Preview" })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});
