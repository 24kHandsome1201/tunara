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
    if (command === "preview_status") {
      return calls.some((call) => call.command === "preview_open") ? { status: "ready", currentUrl: eligible.sourceUrl, canGoBack: false, canGoForward: false } : null;
    }
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
  expect(screen.getByText("Ready")).toBeTruthy();
});

test("keeps SSH, stale, and fallback sources visibly blocked", () => {
  mockIPC((command) => command === "preview_status" ? null : undefined);
  render(<PreviewPanel session={session([
    source({ terminalId: "session-a:1", transport: "ssh", permission: "remote-manual" }),
    source({ terminalId: "session-a:2", state: "stale", staleReason: "terminal-exited" }),
    source({ terminalId: "session-a:3", workspaceResolution: "fallback" }),
  ])} />);

  expect(screen.getAllByText("Closed").length).toBe(2);
  expect(screen.getByText("Source stale / terminal exited")).toBeTruthy();
  for (const button of screen.getAllByRole("button", { name: "Open Preview" })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});

test("shows a failed load with manual recovery and does not pretend it is ready", async () => {
  mockIPC((command) => {
    if (command === "preview_status") return { status: "failed", currentUrl: source().sourceUrl, canGoBack: false, canGoForward: false };
    if (command === "preview_refresh") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  render(<PreviewPanel session={session([source()])} />);

  expect(await screen.findByText("Unreachable / failed")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("did not finish loading");
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open externally" })).toBeTruthy();
});

test("terminal exit keeps close available but blocks refresh and a new internal Preview", async () => {
  mockIPC((command) => command === "preview_status" ? { status: "ready", currentUrl: source().sourceUrl, canGoBack: false, canGoForward: false } : undefined);
  render(<PreviewPanel session={session([source({ state: "stale", staleReason: "terminal-exited" })])} />);

  expect(await screen.findByText("Source stale / terminal exited")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Focus Preview" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
});

test("uses Rust-reported history state and submits addresses through the trusted control plane", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const eligible = source();
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "preview_status") return { status: "ready", currentUrl: "http://127.0.0.1:41731/a", canGoBack: true, canGoForward: false };
    if (["preview_go_back", "preview_navigate"].includes(command)) return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  render(<PreviewPanel session={session([eligible])} />);

  const back = await screen.findByRole("button", { name: "Back" }) as HTMLButtonElement;
  expect(back.disabled).toBe(false);
  expect((screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(back);
  await waitFor(() => expect(calls).toContainEqual({ command: "preview_go_back", payload: { source: eligible } }));

  const address = screen.getByRole("textbox", { name: "Preview address" });
  fireEvent.change(address, { target: { value: "/b?q=1#two" } });
  fireEvent.submit(screen.getByRole("form", { name: "Trusted Preview navigation" }));
  await waitFor(() => expect(calls).toContainEqual({ command: "preview_navigate", payload: { source: eligible, address: "/b?q=1#two" } }));
});
