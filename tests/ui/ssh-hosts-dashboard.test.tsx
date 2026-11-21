import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

  const card = await screen.findByRole("button", { name: "View Production API host details" });
  expect(screen.getByText("api.example.com", { selector: ".ssh-host-card-meta b" })).toBeTruthy();
  expect(screen.getByText("2222", { selector: ".ssh-host-card-meta b" })).toBeTruthy();
  expect(screen.queryByText(/monitor|memory|uptime/i)).toBeNull();

  fireEvent.click(card);
  expect(screen.getByRole("complementary", { name: "Host details" })).toBeTruthy();
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

  await screen.findByRole("button", { name: "View Production API host details" });
  fireEvent.click(screen.getByRole("button", { name: "Online" }));
  expect(screen.getByRole("button", { name: "View Production API host details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Production API host details" }));
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(useUIStore.getState().mainSurface).toBe("terminal");
  expect(useSessionsStore.getState().activeSessionId).toBe(session.id);
});

test("hosts on one endpoint behind different bastions do not share a live terminal", async () => {
  const bastion = (id: string, host: string) => ({ id, label: id, host, port: 22, user: "deploy", auth_method: "agent", identity_file: "" });
  const database = (id: string, label: string, jump: string) => ({ ...bastion(id, "10.0.0.5"), label, proxy_jump_profile_id: jump });
  mockIPC((command) => {
    if (command === "ssh_hosts_load") {
      return [bastion("jump-eu", "eu.example.test"), bastion("jump-us", "us.example.test"), database("db-eu", "EU database", "jump-eu"), database("db-us", "US database", "jump-us")];
    }
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
    throw new Error(`unexpected command: ${command}`);
  });
  const euSession: Session = {
    id: "live-eu",
    title: "EU database",
    dir: "/srv/eu",
    branch: "",
    runState: "idle",
    updatedAt: 1,
    ptyId: 72,
    transportGeneration: "tg-eu",
    remote: {
      host: "10.0.0.5",
      port: 22,
      user: "deploy",
      authMethod: "agent",
      route: { profileId: "jump-eu", jump: { host: "eu.example.test", port: 22, user: "deploy", authMethod: "agent" } },
    },
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  };
  useSessionsStore.setState({ sessions: [euSession], activeSessionId: "" });
  useUIStore.setState({ mainSurface: "ssh-hosts", overlay: null });
  render(<SshHostsDashboard sessions={[euSession]} />);

  const usCard = await screen.findByRole("button", { name: "View US database host details" });
  expect(within(usCard).getByText("Offline")).toBeTruthy();
  expect(within(screen.getByRole("button", { name: "View EU database host details" })).getByText("Online")).toBeTruthy();

  fireEvent.click(usCard);
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(useUIStore.getState().overlay).toBe("ssh");
  expect(useUIStore.getState().mainSurface).toBe("ssh-hosts");
  expect(useSessionsStore.getState().activeSessionId).toBe("");

  useUIStore.setState({ overlay: null });
  fireEvent.click(screen.getByRole("button", { name: "View EU database host details" }));
  fireEvent.click(screen.getByRole("button", { name: "Open terminal" }));
  expect(useUIStore.getState().mainSurface).toBe("terminal");
  expect(useSessionsStore.getState().activeSessionId).toBe("live-eu");
});
