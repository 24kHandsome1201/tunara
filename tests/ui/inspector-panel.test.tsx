import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { InspectorPanel } from "@/ui/InspectorPanel";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";

vi.mock("@/ui/SessionOverviewPanel", () => ({
  SessionOverviewPanel: () => <div data-testid="overview-panel" />,
}));
vi.mock("@/ui/DiffPanel", () => ({
  DiffPanel: () => <div data-testid="changes-panel" />,
}));
vi.mock("@/ui/FileExplorer", () => ({
  FileExplorer: () => <div data-testid="files-panel" />,
}));
vi.mock("@/ui/PreviewPanel", () => ({
  PreviewPanel: () => <div data-testid="preview-panel" />,
}));
vi.mock("@/ui/TransferCenter", () => ({
  TransferCenter: ({ inspectorScope }: { inspectorScope: { kind: string; key: string; logicalSessionId?: string } }) => (
    <div data-testid="transfers-panel" data-scope-kind={inspectorScope.kind} data-scope-key={inspectorScope.key} data-session={inspectorScope.logicalSessionId} />
  ),
}));
vi.mock("@/modules/ssh/remote-fs/RemoteMetadataPanel", () => ({
  RemoteMetadataPanel: ({ path }: { path: string }) => <div data-testid="metadata-panel">{path}</div>,
}));
vi.mock("@/modules/ssh/ForwardingPanel", () => ({
  ForwardingPanel: ({ binding }: { binding: unknown }) => <div data-testid="forwarding-panel">{binding ? "live" : "offline"}</div>,
}));
vi.mock("@/modules/ssh/known-hosts-bridge", () => ({
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

beforeEach(() => {
  useUIStore.setState({ configLoaded: false, inspectorTab: "overview" });
  useSessionsStore.setState({
    activeSessionId: session.id,
    sessions: [session],
    sessionTimelines: {},
  });
});

test("mounts only the active Inspector tab", async () => {
  render(<InspectorPanel session={session} />);

  expect(screen.getByTestId("overview-panel")).toBeTruthy();
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.queryByTestId("preview-panel")).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
  expect(screen.queryByTestId("overview-panel")).toBeNull();
  expect(screen.getByTestId("changes-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.getByTestId("files-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Transfers" }));
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.getByTestId("transfers-panel")).toMatchObject({
    dataset: { scopeKind: "logical-session", scopeKey: `session:${session.id}`, session: session.id },
  });

  fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
  const diagnostics = screen.getByRole("dialog", { name: "SSH diagnostics" });
  fireEvent.keyDown(diagnostics, { key: "Escape" });
  expect(screen.getByTestId("overview-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Known hosts" }));
  expect(await screen.findByText("example.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal of example.com" }));
  expect(await screen.findByText("No known hosts")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
});

test("projects only Files controls in Pure Mode", () => {
  render(<InspectorPanel session={session} filesOnly />);

  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Files"]);
  expect(useUIStore.getState().inspectorTab).toBe("overview");
});

test("flushes a pending note when switching away before the debounce", () => {
  render(<InspectorPanel session={session} />);
  fireEvent.click(screen.getByRole("tab", { name: "Notes" }));

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "pending note" } });
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));

  expect(useSessionsStore.getState().sessions.find((item) => item.id === session.id)?.note).toBe("pending note");
  expect(screen.getByTestId("overview-panel")).toBeTruthy();
});

test("offers forwarding only to SSH sessions and withholds the binding while reconnecting", () => {
  const remoteSession: Session = {
    ...session,
    remote: { host: "example.com", port: 22, user: "deploy", authMethod: "agent" },
    ptyId: 42,
    transportGeneration: "tg-live",
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 2 },
  };
  const view = render(<InspectorPanel session={remoteSession} />);
  fireEvent.click(screen.getByRole("tab", { name: "Forwarding" }));
  expect(screen.getByTestId("forwarding-panel").textContent).toBe("live");

  view.rerender(<InspectorPanel session={{
    ...remoteSession,
    connection: { transport: "ssh", phase: "reconnecting", source: "user", updatedAt: 3 },
  }} />);
  expect(screen.getByTestId("forwarding-panel").textContent).toBe("offline");
});
