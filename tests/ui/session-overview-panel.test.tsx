import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { SessionOverviewPanel } from "../../src/ui/SessionOverviewPanel";
import { useUIStore } from "../../src/state/ui";
import { appendDiagnostic, clearDiagnostics } from "../../src/modules/ssh/diagnostics-store";
import type { Session } from "../../src/ui/types";

const session: Session = {
  id: "overview-session",
  title: "Overview",
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
  connection: { transport: "ssh", phase: "failed", source: "backend", updatedAt: 3 },
};

beforeEach(() => {
  clearDiagnostics();
  useUIStore.setState({ inspectorTab: "overview", panelVisible: true });
});

test("directory and changes cards jump to the matching inspector tabs", () => {
  render(<SessionOverviewPanel session={session} />);
  fireEvent.click(screen.getByRole("button", { name: /Directory/ }));
  expect(useUIStore.getState().inspectorTab).toBe("files");
  fireEvent.click(screen.getByRole("button", { name: /Changes/ }));
  expect(useUIStore.getState().inspectorTab).toBe("changes");
});

test("offers a diagnostics copy action when the remote connection is unhealthy", async () => {
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
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<SessionOverviewPanel session={remoteSession} />);

  fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics report" }));
  await waitFor(() => expect(writeText).toHaveBeenCalled());
});
