import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { InspectorPanel } from "../../src/ui/InspectorPanel";
import { useSessionsStore } from "../../src/state/sessions";
import { useUIStore } from "../../src/state/ui";
import type { Session } from "../../src/ui/types";
import { clearDiagnostics } from "../../src/modules/ssh/diagnostics-store";

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

function chooseSecondaryPanel(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "More inspector tools" }));
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(name) }));
}

beforeEach(() => {
  clearDiagnostics();
  useUIStore.setState({ configLoaded: false, inspectorTab: "changes" });
  useSessionsStore.setState({
    activeSessionId: session.id,
    sessions: [session],
  });
});

test("mounts only the active Inspector panel and keeps specialist tools in overflow", async () => {
  render(<InspectorPanel session={remoteSession} filesOnly={false} />);

  expect(screen.getByTestId("changes-panel")).toBeTruthy();
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.queryByTestId("preview-panel")).toBeNull();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Changes", "Files"]);
  expect(screen.queryByRole("tab", { name: "Preview" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Transfers" })).toBeNull();

  expect(screen.getByText("Scope: Profile")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(screen.queryByTestId("changes-panel")).toBeNull();
  expect(screen.getByTestId("files-panel")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "More inspector tools" }));
  expect(screen.getByText("Workspace")).toBeTruthy();
  expect(screen.getByText("Transfer")).toBeTruthy();
  expect(screen.getByText("SSH")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: /Preview/ }));
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");

  chooseSecondaryPanel("Transfers");
  expect(screen.queryByTestId("preview-panel")).toBeNull();
  expect(screen.getByRole("tab", { name: "Transfers" }).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByTestId("transfers-panel")).toMatchObject({
    dataset: { scopeKind: "logical-session", scopeKey: `session:${session.id}`, session: session.id },
  });

  fireEvent.click(screen.getByRole("button", { name: "More inspector tools" }));
  expect(screen.getByText("SSH")).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: /Forwarding/ })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /Diagnostics/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Known hosts/ })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: /Metadata/ })).toBeNull();
});

test("keeps the active tab visible and preserves APG roving focus navigation", async () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;

  try {
    render(<InspectorPanel session={remoteSession} filesOnly={false} />);
    const changes = screen.getByRole("tab", { name: "Changes" });
    const files = screen.getByRole("tab", { name: "Files" });

    changes.focus();
    fireEvent.keyDown(changes, { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(files));
    expect(files.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(files, { key: "ArrowLeft" });
    await waitFor(() => expect(document.activeElement).toBe(changes));
    expect(changes.getAttribute("aria-selected")).toBe("true");

    chooseSecondaryPanel("Transfers");
    const transfers = screen.getByRole("tab", { name: "Transfers" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" }));
    expect(transfers.getAttribute("aria-selected")).toBe("true");

    transfers.focus();
    fireEvent.keyDown(transfers, { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(changes));
    expect(changes.getAttribute("aria-selected")).toBe("true");
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});

test("projects only Files controls in Pure Mode", () => {
  render(<InspectorPanel session={session} filesOnly />);

  expect(screen.getByTestId("files-panel")).toBeTruthy();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Files"]);
  expect(screen.queryByRole("button", { name: "More inspector tools" })).toBeNull();
  expect(useUIStore.getState().inspectorTab).toBe("changes");
});

test("offers forwarding only to SSH sessions and withholds the binding while reconnecting", async () => {
  const view = render(<InspectorPanel session={remoteSession} filesOnly={false} />);
  chooseSecondaryPanel("Forwarding");
  expect((await screen.findByTestId("forwarding-panel")).textContent).toBe("live");

  view.rerender(<InspectorPanel session={{
    ...remoteSession,
    connection: { transport: "ssh", phase: "reconnecting", source: "user", updatedAt: 3 },
  }} filesOnly={false} />);
  expect(screen.getByTestId("forwarding-panel").textContent).toBe("offline");
});
