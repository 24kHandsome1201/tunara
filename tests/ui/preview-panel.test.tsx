import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { PreviewPanel } from "@/ui/PreviewPanel";
import type { PreviewSource } from "@/modules/preview/preview-source";
import type { Session } from "@/ui/types";
import type { PreviewRuntimeState } from "@/modules/preview/preview-window";

function runtime(overrides: Partial<PreviewRuntimeState> = {}): PreviewRuntimeState {
  return {
    status: "ready",
    currentUrl: "http://127.0.0.1:41731/",
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    viewport: { mode: "reset", requestedWidth: 980, requestedHeight: 720, actualWidth: 980, actualHeight: 720, outerWidth: 980, outerHeight: 748, exact: true },
    telemetry: { generation: 1, events: [], dropped: 0, text: "Preview failures (generation 1)" },
    restart: { eligible: false, reason: "not-failed" },
    ...overrides,
  };
}

function source(overrides: Partial<PreviewSource> = {}): PreviewSource {
  return {
    repositoryId: "repo-a",
    worktreeId: "worktree-a",
    workspaceId: "repo-a::worktree-a",
    sessionId: "session-a",
    terminalId: "session-a:0",
    physicalPtyId: 7,
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
    ptyId: previewSources[0]?.physicalPtyId,
    previewCommandProvenance: previewSources[0]?.restartProvenance,
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
      return calls.some((call) => call.command === "preview_open") ? runtime({ currentUrl: eligible.sourceUrl }) : null;
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
    if (command === "preview_status") return runtime({ status: "failed", currentUrl: source().sourceUrl });
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

test("offers only a proven failed-source command and delegates fill-without-execute to Rust", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const eligible = source({
    restartProvenance: { generation: "session-a:0:1", sequence: 1, command: "python3 -m http.server 41731", submittedAt: 10 },
  });
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "preview_status") return runtime({
      status: "failed",
      currentUrl: eligible.sourceUrl,
      restart: { eligible: true, command: "python3 -m http.server 41731", reason: "ready" },
    });
    if (command === "preview_restart_prepare") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  render(<PreviewPanel session={session([eligible])} />);

  expect(await screen.findByText("python3 -m http.server 41731")).toBeTruthy();
  const prepare = screen.getByRole("button", { name: "Fill source PTY" }) as HTMLButtonElement;
  expect(prepare.disabled).toBe(false);
  fireEvent.click(prepare);
  await waitFor(() => expect(calls).toContainEqual({ command: "preview_restart_prepare", payload: { source: eligible } }));
  expect(calls.some((call) => call.command === "pty_write")).toBe(false);
});

test("keeps restart disabled for busy, stale, changed, exited, or unproven sources", async () => {
  const reasons = ["terminal-busy", "source-stale", "provenance-changed", "pty-exited", "command-unavailable"] as const;
  let index = 0;
  mockIPC((command) => command === "preview_status"
    ? runtime({ status: "failed", restart: { eligible: false, reason: reasons[index++] ?? "command-unavailable" } })
    : undefined);
  render(<PreviewPanel session={session(reasons.map((_, sourceIndex) => source({ terminalId: `session-a:${sourceIndex}` })))} />);

  await screen.findAllByText("Unreachable / failed");
  for (const button of screen.getAllByRole("button", { name: "Fill source PTY" })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
});

test("terminal exit keeps close available but blocks refresh and a new internal Preview", async () => {
  mockIPC((command) => command === "preview_status" ? runtime({ currentUrl: source().sourceUrl }) : undefined);
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
    if (command === "preview_status") return runtime({ currentUrl: "http://127.0.0.1:41731/a", canGoBack: true });
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

test("changes zoom and viewport only after Rust reports native state", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  let state = runtime();
  const eligible = source();
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "preview_status") return state;
    if (command === "preview_set_zoom") {
      state = runtime({ zoomFactor: 1.25 });
      return undefined;
    }
    if (command === "preview_set_viewport") {
      state = runtime({ viewport: { mode: "preset", requestedWidth: 390, requestedHeight: 844, actualWidth: 390, actualHeight: 844, outerWidth: 390, outerHeight: 872, exact: true } });
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  render(<PreviewPanel session={session([eligible])} />);

  const zoom = await screen.findByRole("button", { name: "125%" });
  expect(zoom.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(zoom);
  await waitFor(() => expect(zoom.getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "Phone 390×844" }));
  await screen.findByText("390×844");
  expect(calls).toContainEqual({ command: "preview_set_zoom", payload: { source: eligible, factor: 1.25 } });
  expect(calls).toContainEqual({ command: "preview_set_viewport", payload: { source: eligible, width: 390, height: 844 } });
});

test("shows bounded failures and explicitly copies, clears, or fills only the source PTY", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const eligible = source({ sourceUrl: "http://127.0.0.1:41731/app?token=secret#private" });
  let state = runtime({
    currentUrl: eligible.sourceUrl,
    telemetry: {
      generation: 4,
      events: [
        { kind: "console-error", message: "Render failed", count: 2 },
        { kind: "network-failure", message: "GET /api · HTTP 503 · fetch", count: 1 },
      ],
      dropped: 3,
      text: "Preview failures (generation 4)\n[console-error] Render failed ×2\n[network-failure] GET /api · HTTP 503 · fetch",
    },
  });
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "preview_status") return state;
    if (command === "preview_telemetry_send") return undefined;
    if (command === "preview_telemetry_clear") {
      state = runtime({ telemetry: { generation: 4, events: [], dropped: 0, text: "Preview failures (generation 4)" } });
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  render(<PreviewPanel session={session([eligible])} />);

  expect(await screen.findByText("Render failed ×2")).toBeTruthy();
  expect(screen.getByText("GET /api · HTTP 503 · fetch")).toBeTruthy();
  expect(screen.queryByText(/token=secret/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send to source PTY" }));
  await waitFor(() => expect(calls).toContainEqual({ command: "preview_telemetry_send", payload: { source: eligible } }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await screen.findByText("No bounded console or network failures for this Preview generation.");
});
