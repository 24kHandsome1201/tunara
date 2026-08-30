import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { calculateSshSystemRates, type SshSystemSnapshotV1 } from "@/modules/ssh/system-monitor-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SshHostsDashboard } from "@/ui/SshHostsDashboard";
import type { Session } from "@/ui/types";

const savedHost = {
  id: "production",
  label: "Production API",
  host: "api.example.com",
  port: 2222,
  user: "deploy",
  auth_method: "agent",
  identity_file: "",
};

function mockHosts(onCommand?: (command: string, payload: unknown) => unknown) {
  mockIPC((command, payload) => {
    if (command === "ssh_hosts_load") return [savedHost];
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
    const result = onCommand?.(command, payload);
    if (result !== undefined) return result;
    throw new Error(`unexpected command: ${command}`);
  });
}

test("offline cards show truthful missing monitoring data and open a full detail surface", async () => {
  const commands: string[] = [];
  mockHosts((command) => { commands.push(command); });
  render(<SshHostsDashboard sessions={[]} />);

  const card = await screen.findByRole("button", { name: "View Production API server details" });
  expect(screen.getByText("api.example.com", { selector: ".ssh-host-card-meta b" })).toBeTruthy();
  expect(screen.getByText("2222", { selector: ".ssh-host-card-meta b" })).toBeTruthy();
  expect(screen.getByText("No monitoring data. Connect to this server to start monitoring.")).toBeTruthy();
  expect(commands).not.toContain("ssh_system_snapshot_v1");

  fireEvent.click(card);
  expect(screen.getByRole("complementary", { name: "Server details" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  expect(screen.getByText("Connection information")).toBeTruthy();
});

test("ready SSH hosts sample real memory and cumulative network counters through the full binding", async () => {
  const monitorPayloads: unknown[] = [];
  useUIStore.setState({ mainSurface: "ssh-hosts" });
  mockHosts((command, payload) => {
    if (command !== "ssh_system_snapshot_v1") return undefined;
    monitorPayloads.push(payload);
    return {
      status: "available",
      observedAt: 1_000,
      memoryTotalBytes: 1024 * 1024,
      memoryAvailableBytes: 256 * 1024,
      rxBytes: 10_000,
      txBytes: 4_000,
      uptimeSeconds: 90_000,
    };
  });
  const session: Session = {
    id: "live-production",
    title: "Production API",
    dir: "/srv/api",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    ptyId: 71,
    transportGeneration: "tg-production",
    remote: { host: "api.example.com", port: 2222, user: "deploy", authMethod: "agent" },
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  };
  useSessionsStore.setState({ sessions: [session], activeSessionId: "live-production" });

  const view = render(<SshHostsDashboard sessions={[session]} />);

  await waitFor(() => expect(monitorPayloads).toHaveLength(1));
  expect(monitorPayloads[0]).toEqual({
    binding: {
      logicalSessionId: "live-production",
      physicalPtyId: 71,
      transportGeneration: "tg-production",
    },
  });
  expect(await screen.findByText("768 KB / 1.00 MB")).toBeTruthy();
  expect(screen.getAllByText("Online")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "View Production API server details" }));
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(useUIStore.getState().mainSurface).toBe("terminal");
  expect(useSessionsStore.getState().activeSessionId).toBe("live-production");
  expect(screen.getByText("1d 1h")).toBeTruthy();

  view.rerender(<SshHostsDashboard sessions={[]} />);
  expect(screen.queryByText("768 KB / 1.00 MB")).toBeNull();
  expect(screen.getAllByText("No monitoring data. Connect to this server to start monitoring.")).toHaveLength(2);
});

test("network rates require increasing time and counters and reject resets", () => {
  const first: SshSystemSnapshotV1 = {
    status: "available",
    observedAt: 1_000,
    memoryTotalBytes: 100,
    memoryAvailableBytes: 50,
    rxBytes: 1_000,
    txBytes: 2_000,
  };
  const second: SshSystemSnapshotV1 = {
    ...first,
    observedAt: 3_000,
    rxBytes: 5_000,
    txBytes: 3_000,
  };
  expect(calculateSshSystemRates(first, second)).toEqual({
    downloadBytesPerSecond: 2_000,
    uploadBytesPerSecond: 500,
  });
  expect(calculateSshSystemRates(second, { ...second, observedAt: 4_000, rxBytes: 1 })).toBeUndefined();
  expect(calculateSshSystemRates(first, { ...second, observedAt: 1_000 })).toBeUndefined();
});
