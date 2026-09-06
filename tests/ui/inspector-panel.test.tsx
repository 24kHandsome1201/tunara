import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { InspectorPanel } from "../../src/ui/InspectorPanel";
import { useSessionsStore } from "../../src/state/sessions";
import { useUIStore } from "../../src/state/ui";
import type { Session } from "../../src/ui/types";
import { clearDiagnostics } from "../../src/modules/ssh/diagnostics-store";
import { useTransferStore } from "../../src/modules/ssh/transfer-store";
import type { PreviewSource } from "../../src/modules/preview/preview-source";

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
vi.mock("../../src/modules/ssh/ForwardingPanel", () => ({
  ForwardingPanel: ({ binding }: { binding: unknown }) => <div data-testid="forwarding-panel">{binding ? "live" : "offline"}</div>,
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

function previewSource(): PreviewSource {
  return {
    repositoryId: "repo-a",
    worktreeId: "worktree-a",
    workspaceId: "repo-a::worktree-a",
    sessionId: session.id,
    terminalId: `${session.id}:0`,
    physicalPtyId: 42,
    sourceUrl: "http://127.0.0.1:4173/",
    discoveredAt: 1,
    transport: "local",
    workspaceResolution: "resolved",
    permission: "eligible",
    state: "active",
  };
}

beforeEach(() => {
  clearDiagnostics();
  useTransferStore.getState().replaceItemsForTest([]);
  useUIStore.setState({
    configLoaded: false,
    inspectorTab: "files",
    inspectorPreviewOpenedSessionIds: {},
    readers: {},
    focusedPaneId: null,
  });
  useSessionsStore.setState({
    activeSessionId: session.id,
    sessions: [session],
  });
});

test("mounts only the active panel and keeps unavailable tools in More", async () => {
  render(<InspectorPanel session={remoteSession} filesOnly={false} />);

  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.queryByTestId("preview-panel")).toBeNull();
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual([
    "Files",
    "Changes",
  ]);
  expect(screen.queryByText("Auto")).toBeNull();
  expect(screen.queryByText("Locked")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More inspector tools" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Preview",
    "Transfers",
    "Forwarding",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Preview" }));
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  expect(useUIStore.getState().inspectorPreviewOpenedSessionIds[session.id]).toBe(true);

  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(await screen.findByTestId("changes-panel")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Return Inspector to automatic follow" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  expect(useUIStore.getState().inspectorPreviewOpenedSessionIds[session.id]).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "More inspector tools" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Transfers" }));
  expect(screen.queryByTestId("preview-panel")).toBeNull();
  expect(screen.getByRole("tab", { name: "Transfers" }).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByTestId("transfers-panel")).toMatchObject({
    dataset: { scopeKind: "logical-session", scopeKey: `session:${session.id}`, session: session.id },
  });

  expect(screen.queryByRole("tab", { name: "Forwarding" })).toBeNull();
});

test("keeps the active tab visible and preserves APG roving focus navigation", async () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;

  try {
    useUIStore.setState({ inspectorTab: "changes" });
    render(<InspectorPanel session={remoteSession} filesOnly={false} />);
    const changes = screen.getByRole("tab", { name: "Changes" });
    const files = screen.getByRole("tab", { name: "Files" });

    changes.focus();
    fireEvent.keyDown(changes, { key: "End" });
    expect(document.activeElement).toBe(changes);
    expect(changes.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(changes, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Files" })));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(files, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(changes));
    expect(changes.getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("projects only Files controls when filesOnly is set", () => {
  useUIStore.setState({ inspectorTab: "changes" });
  render(<InspectorPanel session={session} filesOnly />);

  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Files"]);
  expect(screen.queryByText("Auto")).toBeNull();
  expect(screen.queryByText("Locked")).toBeNull();
  expect(screen.queryByRole("button", { name: "Return Inspector to automatic follow" })).toBeNull();
  expect(useUIStore.getState().inspectorTab).toBe("changes");
});

test("offers forwarding only to SSH sessions and withholds the binding while reconnecting", async () => {
  useUIStore.setState({ inspectorTab: "forwarding" });
  const view = render(<InspectorPanel session={remoteSession} filesOnly={false} />);
  expect((await screen.findByTestId("forwarding-panel")).textContent).toBe("live");

  view.rerender(<InspectorPanel session={{
    ...remoteSession,
    connection: { transport: "ssh", phase: "reconnecting", source: "user", updatedAt: 3 },
  }} filesOnly={false} />);
  expect(screen.getByTestId("forwarding-panel").textContent).toBe("offline");
});

test("does not auto-switch for current-session changes", async () => {
  const dirty: Session = {
    ...session,
    reviewChangesHint: true,
    changes: { files: [{ path: "src/a.ts", status: "modified", stage: "unstaged", added: 1, removed: 0 }] },
  };
  const view = render(<InspectorPanel session={dirty} filesOnly={false} />);
  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(useUIStore.getState().inspectorTab).toBe("files");
  view.rerender(<InspectorPanel session={dirty} filesOnly={false} />);
  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(useUIStore.getState().inspectorTab).toBe("files");
});

test("keeps the reader and file list in place when new changes arrive", async () => {
  useUIStore.setState({
    inspectorTab: "files",
    readers: {
      [session.id]: {
        current: { filePath: "/tmp/project/src/a.ts", fileName: "a.ts" },
        history: [{ filePath: "/tmp/project/src/a.ts", fileName: "a.ts" }],
        historyIndex: 0,
        dirty: false,
      },
    },
    focusedPaneId: `reader:${session.id}`,
  });
  render(<InspectorPanel session={{
    ...session,
    reviewChangesHint: true,
    changes: { files: [{ path: "src/a.ts", status: "modified", stage: "unstaged", added: 1, removed: 0 }] },
  }} filesOnly={false} />);

  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(screen.queryByText("Unreviewed changes are ready.")).toBeNull();
  expect(useUIStore.getState().inspectorTab).toBe("files");
});

test("shows Preview for a source but changes view only on user activation", () => {
  const withSource: Session = { ...session, previewSources: [previewSource()] };
  render(<InspectorPanel session={withSource} filesOnly={false} />);
  expect(screen.getByTestId("files-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
  expect(useUIStore.getState().inspectorPreviewOpenedSessionIds[session.id]).toBe(true);
});

test("keeps explicit selection across session and activity changes", async () => {
  useUIStore.setState({ inspectorTab: "changes" });
  const view = render(<InspectorPanel session={session} />);
  expect(await screen.findByTestId("changes-panel")).toBeTruthy();
  view.rerender(<InspectorPanel session={{ ...remoteSession, id: "another-session", agentActivity: "running", previewSources: [previewSource()] }} />);
  expect(screen.getByTestId("changes-panel")).toBeTruthy();
  expect(useUIStore.getState().inspectorTab).toBe("changes");
});
