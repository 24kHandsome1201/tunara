import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { AgentTimelinePanel } from "@/ui/AgentTimelinePanel";
import { agentEventWorkspaceId, type AgentEventHeaderV1 } from "@/modules/agent-events/agent-event-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";

function session(): Session {
  return {
    id: "session-a",
    title: "构建 release / Build release",
    dir: "/Users/fixture/一个很长的仓库/worktree-a",
    branch: "codex/phase4-agent-timeline",
    runState: "idle",
    updatedAt: 1,
    workspaceState: "ready",
    workspace: {
      repository: { id: "workspace-fixture", name: "rail-long-repository-name", commonGitDir: "/repo/.git", transport: "local", bare: false },
      currentWorktreeId: "worktree-a",
      worktrees: [{ id: "worktree-a", name: "phase4-时间线", path: "/repo/worktrees/phase4", branch: "codex/phase4-agent-timeline", detached: false, current: true, locked: false, available: true }],
    },
  };
}

function header(sequence: number, overrides: Partial<AgentEventHeaderV1> = {}): AgentEventHeaderV1 {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    clientEventId: `client-${sequence}`,
    workspaceId: "workspace-fixture",
    taskId: "session-a",
    sessionId: "session-a",
    kind: sequence % 9 === 0 ? "confirmation_request" : "output_summary",
    source: sequence % 5 === 0 ? "heuristic" : "hook",
    occurredAtMs: 1_700_000_000_000 + sequence,
    recordedAtMs: 1_700_000_000_000 + sequence,
    summary: `Header ${sequence} 中文 long repository transition summary`,
    ...overrides,
  };
}

function enabledStatus() {
  return {
    capability: "enabled",
    schemaVersion: 1,
    dataLocation: "<app-local-data>/agent-events/v1",
    eventCount: 10_000,
    payloadBytes: 0,
    recoveredPartialTail: false,
    retention: { maxEvents: 100_000, maxPayloadBytes: 268_435_456, autoPrune: false },
    export: { supported: false, backgroundExport: false },
    privacy: { headerContainsPrivateBody: false, payloadRequiresExplicitRead: true, telemetryUpload: false },
  };
}

async function sha256(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

test("renders a bounded virtual header window and returns only to a proven PTY", async () => {
  const workspaceId = await agentEventWorkspaceId("workspace-fixture");
  expect(workspaceId).toMatch(/^ws-[0-9a-f]{64}$/);
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "agent_event_store_status") return enabledStatus();
    if (command === "plugin:event|listen") return 7;
    if (command === "agent_event_list") return { items: Array.from({ length: 100 }, (_, index) => header(10_000 - index, { workspaceId, payload: { state: "available", contentType: "text/markdown", byteLength: 7, sha256: "0".repeat(64) } })), nextCursor: "older", snapshotUpperBound: 10_000 };
    if (command === "plugin:event|unlisten") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  const active = session();
  useSessionsStore.setState({ sessions: [active], activeSessionId: active.id, launchedSessionIds: { [active.id]: true } });
  useUIStore.setState({ panelVisible: true });
  const { container } = render(<AgentTimelinePanel session={active} />);

  await screen.findByRole("listbox", { name: "Agent event headers" });
  await waitFor(() => expect(container.querySelectorAll(".agent-timeline-row").length).toBeGreaterThan(0));
  expect(container.querySelectorAll(".agent-timeline-row").length).toBeLessThan(30);
  expect(container.textContent).not.toContain("private payload");
  expect(calls).not.toContain("agent_event_payload");

  fireEvent.click(container.querySelector(".agent-timeline-row") as HTMLElement);
  const returnButton = await screen.findByRole("button", { name: "Return to PTY" }) as HTMLButtonElement;
  expect(returnButton.disabled).toBe(false);
  fireEvent.click(returnButton);
  expect(useSessionsStore.getState().activeSessionId).toBe("session-a");
  expect(useUIStore.getState().panelVisible).toBe(false);
});

test("disabled capability never reads an event page and leaves terminal state untouched", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "agent_event_store_status") return { ...enabledStatus(), capability: "disabled" };
    throw new Error(`unexpected command: ${command}`);
  });
  const active = session();
  useSessionsStore.setState({ sessions: [active], activeSessionId: active.id, launchedSessionIds: { [active.id]: true } });
  render(<AgentTimelinePanel session={active} />);

  expect(await screen.findByText("Event Store is disabled")).toBeTruthy();
  expect(calls).toEqual(["agent_event_store_status"]);
  expect(useSessionsStore.getState().activeSessionId).toBe("session-a");
});

test("unproven source stays visible as unknown and disables PTY navigation", async () => {
  const workspaceId = await agentEventWorkspaceId("workspace-fixture");
  mockIPC((command) => {
    if (command === "agent_event_store_status") return enabledStatus();
    if (command === "plugin:event|listen") return 8;
    if (command === "agent_event_list") return { items: [header(1, { workspaceId, sessionId: "missing-session", source: "heuristic" })], nextCursor: null, snapshotUpperBound: 1 };
    if (command === "plugin:event|unlisten") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  const active = session();
  useSessionsStore.setState({ sessions: [active], activeSessionId: active.id, launchedSessionIds: { [active.id]: true } });
  const { container } = render(<AgentTimelinePanel session={active} />);

  expect((await screen.findAllByText("unknown")).length).toBeGreaterThanOrEqual(2);
  fireEvent.click(container.querySelector(".agent-timeline-row") as HTMLElement);
  expect((await screen.findByRole("button", { name: "Return to PTY" }) as HTMLButtonElement).disabled).toBe(true);
});

test("keyboard expansion reads one proven payload on demand and Escape returns to PTY", async () => {
  const workspaceId = await agentEventWorkspaceId("workspace-fixture");
  const body = "# Evidence\n\n```ts\nconst safe = true\n```";
  const hash = await sha256(body);
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "agent_event_store_status") return enabledStatus();
    if (command === "plugin:event|listen") return 9;
    if (command === "agent_event_list") return { items: [header(1, { workspaceId, payload: { state: "available", contentType: "text/markdown", byteLength: new TextEncoder().encode(body).byteLength, sha256: hash } })], nextCursor: null, snapshotUpperBound: 1 };
    if (command === "agent_event_payload") return { eventId: "event-1", contentType: "text/markdown", body, byteLength: new TextEncoder().encode(body).byteLength, sha256: hash };
    if (command === "plugin:event|unlisten") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  const active = session();
  useSessionsStore.setState({ sessions: [active], activeSessionId: active.id, launchedSessionIds: { [active.id]: true } });
  useUIStore.setState({ panelVisible: true });
  const { container } = render(<AgentTimelinePanel session={active} />);

  const listbox = await screen.findByRole("listbox", { name: "Agent event headers" });
  await waitFor(() => expect(container.querySelector(".agent-timeline-row")).toBeTruthy());
  expect(calls).not.toContain("agent_event_payload");
  fireEvent.click(container.querySelector(".agent-timeline-row") as HTMLElement);
  fireEvent.keyDown(listbox, { key: "Enter" });
  expect(await screen.findByText("Evidence")).toBeTruthy();
  expect(calls.filter((command) => command === "agent_event_payload")).toHaveLength(1);
  fireEvent.keyDown(listbox, { key: "Escape" });
  expect(screen.queryByText("Evidence")).toBeNull();
  fireEvent.keyDown(listbox, { key: "Escape" });
  expect(useUIStore.getState().panelVisible).toBe(false);
});
