import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { InspectorPanel } from "../../src/ui/InspectorPanel";
import { useSessionsStore } from "../../src/state/sessions";
import { useUIStore } from "../../src/state/ui";
import type { Session } from "../../src/ui/types";
import { appendDiagnostic, clearDiagnostics } from "../../src/modules/ssh/diagnostics-store";

vi.mock("../../src/ui/SessionOverviewPanel", () => ({
  SessionOverviewPanel: () => <div data-testid="overview-panel" />,
}));
vi.mock("../../src/ui/DiffPanel", () => ({
  DiffPanel: () => <div data-testid="changes-panel" />,
}));
vi.mock("../../src/ui/FileExplorer", () => ({
  FileExplorer: () => <div data-testid="files-panel" />,
}));
vi.mock("../../src/ui/PreviewPanel", () => ({
  PreviewPanel: () => <div data-testid="preview-panel" />,
}));
vi.mock("../../src/ui/TransferCenter", () => ({
  TransferCenter: ({ inspectorScope }: { inspectorScope: { kind: string; key: string; logicalSessionId?: string } }) => (
    <div data-testid="transfers-panel" data-scope-kind={inspectorScope.kind} data-scope-key={inspectorScope.key} data-session={inspectorScope.logicalSessionId} />
  ),
}));
vi.mock("../../src/modules/ssh/remote-fs/RemoteMetadataPanel", () => ({
  RemoteMetadataPanel: ({ path }: { path: string }) => <div data-testid="metadata-panel">{path}</div>,
}));
vi.mock("../../src/modules/ssh/ForwardingPanel", () => ({
  ForwardingPanel: ({ binding }: { binding: unknown }) => <div data-testid="forwarding-panel">{binding ? "live" : "offline"}</div>,
}));
vi.mock("../../src/modules/ssh/known-hosts-bridge", () => ({
  listKnownHostsV1: async () => ({ revision: "r1", entries: [{ entryId: "e1", line: 1, marker: null, patternDisplay: "example.com", keyType: "ssh-ed25519", fingerprint: "SHA256:safe", manageable: true }] }),
  refreshKnownHostsV1: async () => ({ revision: "r1", entries: [] }),
  removeKnownHostV1: async () => ({ revision: "r2", entries: [] }),
}));

const session: Session = {
  id: "inspector-session",
  title: "Inspector test",
  dir: "/tmp/project",
  branch: "main",
  runState: "idle",
  updatedAt: 1,
};

const remoteSession: Session = {
  ...session,
  remote: { host: "example.com", port: 22, user: "deploy", authMethod: "agent" },
  ptyId: 42,
  transportGeneration: "tg-live",
  connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 2 },
};

function chooseSecondaryPanel(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "More inspector tools" }));
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(name) }));
}

beforeEach(() => {
  clearDiagnostics();
  useUIStore.setState({ configLoaded: false, inspectorTab: "overview" });
  useSessionsStore.setState({
    activeSessionId: session.id,
    sessions: [session],
    sessionTimelines: {},
  });
});

test("mounts only the active Inspector panel and keeps specialist tools in overflow", async () => {
  render(<InspectorPanel session={remoteSession} filesOnly={false} />);

  expect(screen.getByTestId("overview-panel")).toBeTruthy();
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.queryByTestId("preview-panel")).toBeNull();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Changes", "Files"]);
  expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Transfers" })).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  expect(screen.queryByTestId("overview-panel")).toBeNull();
  expect(screen.getByTestId("changes-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.getByTestId("files-panel")).toBeTruthy();

  chooseSecondaryPanel("Preview");
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");

  chooseSecondaryPanel("Transfers");
  expect(screen.queryByTestId("preview-panel")).toBeNull();
  expect(screen.getByRole("tab", { name: "Transfers" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("transfers-panel")).toMatchObject({
    dataset: { scopeKind: "logical-session", scopeKey: `session:${session.id}`, session: session.id },
  });

  chooseSecondaryPanel("Diagnostics");
  const diagnostics = screen.getByRole("region", { name: "SSH diagnostics" });
  expect(screen.getByRole("status").textContent).toContain("No diagnostics for this session");
  expect(screen.queryByRole("button", { name: "Copy de-identified report" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  fireEvent.keyDown(diagnostics, { key: "Escape" });
  expect(screen.getByTestId("overview-panel")).toBeTruthy();

  chooseSecondaryPanel("Known hosts");
  expect(await screen.findByText("example.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal of example.com" }));
  expect(await screen.findByText("No known hosts")).toBeTruthy();
});

test("keeps the active tab visible and preserves APG roving focus navigation", async () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;

  try {
    render(<InspectorPanel session={remoteSession} filesOnly={false} />);
    const overview = screen.getByRole("tab", { name: "Overview" });
    const changes = screen.getByRole("tab", { name: "Changes" });
    const files = screen.getByRole("tab", { name: "Files" });

    overview.focus();
    fireEvent.keyDown(overview, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(files));
    expect(files.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(files, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(changes));
    expect(changes.getAttribute("aria-selected")).toBe("true");

    chooseSecondaryPanel("Known hosts");
    const knownHosts = screen.getByRole("tab", { name: "Known hosts" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" }));
    expect(knownHosts.getAttribute("aria-selected")).toBe("true");

    knownHosts.focus();
    fireEvent.keyDown(knownHosts, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(overview));
    expect(overview.getAttribute("aria-selected")).toBe("true");
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("diagnostic actions appear only when there is a report to copy or clear", () => {
  appendDiagnostic(session.id, {
    requestId: "request-1",
    status: "failed",
    diagnostic: {
      schemaVersion: 1,
      stage: "auth",
      code: "authenticationFailed",
      severity: "error",
      retryable: false,
      hopRole: "direct",
      timestamp: 1,
    },
  });
  useUIStore.setState({ inspectorTab: "diagnostics" });
  render(<InspectorPanel session={remoteSession} filesOnly={false} />);

  expect(screen.getByRole("button", { name: "Copy de-identified report" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(screen.getByRole("status").textContent).toContain("No diagnostics for this session");
  expect(screen.queryByRole("button", { name: "Copy de-identified report" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
});

test("projects only Files controls in Pure Mode", () => {
  render(<InspectorPanel session={session} filesOnly />);

  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Files"]);
  expect(screen.queryByRole("button", { name: "More inspector tools" })).toBeNull();
  expect(useUIStore.getState().inspectorTab).toBe("overview");
});

test("flushes a pending note when switching away before the debounce", () => {
  render(<InspectorPanel session={session} filesOnly={false} />);
  chooseSecondaryPanel("Notes");

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "pending note" } });
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));

  expect(useSessionsStore.getState().sessions.find((item) => item.id === session.id)?.note).toBe("pending note");
  expect(screen.getByTestId("overview-panel")).toBeTruthy();
});

test("offers forwarding only to SSH sessions and withholds the binding while reconnecting", () => {
  const view = render(<InspectorPanel session={remoteSession} filesOnly={false} />);
  chooseSecondaryPanel("Forwarding");
  expect(screen.getByTestId("forwarding-panel").textContent).toBe("live");

  view.rerender(<InspectorPanel session={{
    ...remoteSession,
    connection: { transport: "ssh", phase: "reconnecting", source: "user", updatedAt: 3 },
  }} filesOnly={false} />);
  expect(screen.getByTestId("forwarding-panel").textContent).toBe("offline");
});
