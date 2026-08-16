import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Sidebar } from "../../src/ui/Sidebar";
import { useUIStore } from "../../src/state/ui";
import type { Session } from "../../src/ui/types";

function localSession(id: string, dir: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, dir, branch: "", runState: "idle", updatedAt: 1, ...patch };
}

function sshSession(id: string, dir: string, host = "box.example", patch: Partial<Session> = {}): Session {
  return localSession(id, dir, {
    remote: { host, port: 22, user: "deploy", authMethod: "agent" },
    ...patch,
  });
}

test("sidebar keeps local /tmp and SSH /tmp in separate groups", () => {
  const onSelect = vi.fn();
  render(
    <Sidebar
      sessions={[localSession("local-tmp", "/tmp"), sshSession("ssh-tmp", "/tmp")]}
      activeSessionId="local-tmp"
      onSelectSession={onSelect}
    />,
  );

  expect(screen.getByRole("group", { name: /\/tmp/ })).toBeTruthy();
  expect(screen.getByRole("group", { name: /deploy@box\.example, SSH/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /New terminal in this directory/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /New window on this host/ })).toBeTruthy();
});

test("OSC 7 cwd changes stay in the same SSH host group", () => {
  render(
    <Sidebar
      sessions={[
        sshSession("a", "deploy@box.example"),
        sshSession("b", "/var/www"),
      ]}
      activeSessionId="a"
      onSelectSession={vi.fn()}
    />,
  );

  expect(screen.getAllByRole("group", { name: /deploy@box\.example, SSH/ })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /Remote SSH session, deploy@box\.example/ })).toHaveLength(2);
});

test("SSH connecting phase is visible on the card and not in the attention bar", () => {
  render(
    <Sidebar
      sessions={[sshSession("s", "/root", "box.example", {
        connection: { transport: "ssh", phase: "connecting", source: "backend", updatedAt: 2 },
      })]}
      activeSessionId="s"
      onSelectSession={vi.fn()}
    />,
  );

  expect(screen.getByText("Connecting to host")).toBeTruthy();
  expect(screen.queryByText("Needs attention")).toBeNull();
});

test("saved hosts collapse when sessions exist and focus a live session on click", async () => {
  mockIPC((command) => {
    if (command === "ssh_hosts_load") {
      return [{ id: "saved-box", label: "lab box", host: "box.example", port: 22, user: "deploy", identity_file: "" }];
    }
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
    return undefined;
  });
  const onSelect = vi.fn();
  render(
    <Sidebar
      sessions={[sshSession("live", "/root")]}
      activeSessionId="live"
      onSelectSession={onSelect}
    />,
  );

  const toggle = await screen.findByRole("button", { name: /Saved hosts · 1/ });
  expect(screen.queryByRole("button", { name: "lab box" })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(await screen.findByRole("button", { name: "lab box" }));
  expect(onSelect).toHaveBeenCalledWith("live");
  expect(useUIStore.getState().overlay).not.toBe("ssh");
});

test("saved hosts open the connect sheet when the host has no live session", async () => {
  mockIPC((command) => {
    if (command === "ssh_hosts_load") {
      return [{ id: "saved-other", label: "other box", host: "other.example", port: 22, user: "ops", identity_file: "" }];
    }
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
    return undefined;
  });
  render(
    <Sidebar
      sessions={[sshSession("live", "/root")]}
      activeSessionId="live"
      onSelectSession={vi.fn()}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: /Saved hosts · 1/ }));
  fireEvent.click(await screen.findByRole("button", { name: "other box" }));
  await waitFor(() => expect(useUIStore.getState().overlay).toBe("ssh"));
});
