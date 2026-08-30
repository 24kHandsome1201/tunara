import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
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

function mockHosts(commands: string[] = []) {
  mockIPC((command) => {
    commands.push(command);
    if (command === "ssh_hosts_load") return [savedHost];
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
    throw new Error(`unexpected command: ${command}`);
  });
}

test("saved hosts expose compact connection details without monitoring IPC", async () => {
  const commands: string[] = [];
  mockHosts(commands);
  render(<SshHostsDashboard sessions={[]} />);

  const card = await screen.findByRole("button", { name: "View Production API server details" });
  expect(screen.getByText("api.example.com", { selector: ".ssh-host-card-meta b" })).toBeTruthy();
  expect(screen.getByText("2222", { selector: ".ssh-host-card-meta b" })).toBeTruthy();
  expect(screen.queryByText(/monitor|memory|uptime/i)).toBeNull();

  fireEvent.click(card);
  expect(screen.getByRole("complementary", { name: "Server details" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connection settings" })).toBeTruthy();
  expect(screen.getByText("Connection information")).toBeTruthy();
  expect(commands).toEqual(["ssh_hosts_load", "ssh_hosts_import_config"]);
});

test("online filter and Open terminal use existing connection state only", async () => {
  mockHosts();
  useUIStore.setState({ mainSurface: "ssh-hosts" });
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
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  render(<SshHostsDashboard sessions={[session]} />);

  await screen.findByRole("button", { name: "View Production API server details" });
  fireEvent.click(screen.getByRole("button", { name: "Online" }));
  expect(screen.getByRole("button", { name: "View Production API server details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Production API server details" }));
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(useUIStore.getState().mainSurface).toBe("terminal");
  expect(useSessionsStore.getState().activeSessionId).toBe(session.id);
});
