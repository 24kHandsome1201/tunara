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

test("mounts only the active Inspector tab", () => {
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

  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.queryByTestId("files-panel")).toBeNull();
  expect(screen.getByTestId("preview-panel")).toBeTruthy();
});

test("flushes a pending note when switching away before the debounce", () => {
  render(<InspectorPanel session={session} />);
  fireEvent.click(screen.getByRole("tab", { name: "Notes" }));

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "pending note" } });
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));

  expect(useSessionsStore.getState().sessions.find((item) => item.id === session.id)?.note).toBe("pending note");
  expect(screen.getByTestId("overview-panel")).toBeTruthy();
});
