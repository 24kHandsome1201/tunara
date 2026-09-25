import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Sidebar } from "../../src/ui/Sidebar";
import { WorkspaceEmptyState } from "../../src/ui/WorkspaceEmptyState";
import { useSessionsStore } from "../../src/state/sessions";
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
  expect(screen.getByLabelText("Search sessions")).toBeTruthy();
  expect(screen.getByRole("button", { name: /New terminal in this directory/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /New window on this host/ })).toBeTruthy();
});

test("zero-session sidebar removes search and duplicate terminal actions", () => {
  render(
    <Sidebar
      sessions={[]}
      activeSessionId=""
      onSelectSession={vi.fn()}
      onNewTerminal={vi.fn()}
      onNewTerminalInDirectory={vi.fn()}
    />,
  );

  expect(screen.queryByLabelText("Search sessions")).toBeNull();
  expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
  expect(screen.queryByText("No sessions yet")).toBeNull();
  expect(screen.queryByRole("region", { name: "SSH hosts" })).toBeNull();
});

test("sidebar offers direct terminal creation and a secondary launch menu", () => {
  const onNewTerminal = vi.fn();
  const onNewTerminalInDirectory = vi.fn();
  render(
    <Sidebar
      sessions={[localSession("local", "/tmp")]}
      activeSessionId="local"
      onSelectSession={vi.fn()}
      onNewTerminal={onNewTerminal}
      onNewTerminalInDirectory={onNewTerminalInDirectory}
    />,
  );

  const trigger = screen.getByRole("button", { name: "New session menu" });
  fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
  expect(onNewTerminal).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "New terminal" })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: "New terminal in folder…" })).toBeTruthy();
  expect(within(menu).getByRole("menuitem", { name: "New SSH connection…" })).toBeTruthy();
});

test("empty workspace keeps one quiet launcher above recent folders and SSH hosts", async () => {
  mockIPC((command) => {
    if (command === "ssh_hosts_load") {
      return [{ id: "saved-box", label: "lab box", host: "box.example", port: 22, user: "deploy", identity_file: "" }];
    }
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
    if (command === "fs_scan_recent_repos") return [];
    return undefined;
  });
  useSessionsStore.setState({ sessions: [], activeSessionId: null, recentDirs: ["/tmp/project"] });
  useUIStore.setState({ overlay: null, sshPrefill: null });
  const onNewTerminal = vi.fn();
  const onNewTerminalInDirectory = vi.fn();
  const onOpenSsh = vi.fn();

  render(
    <WorkspaceEmptyState
      onNewTerminal={onNewTerminal}
      onNewTerminalInDirectory={onNewTerminalInDirectory}
      onOpenSsh={onOpenSsh}
    />,
  );

  expect(screen.queryByText("No sessions")).toBeNull();
  const launcher = screen.getByRole("group", { name: "Start a session" });
  expect(within(launcher).getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Local terminal",
    "Open terminal in folder",
    "Connect SSH",
  ]);
  fireEvent.click(within(launcher).getByRole("button", { name: "Local terminal" }));
  fireEvent.click(within(launcher).getByRole("button", { name: "Open terminal in folder" }));
  fireEvent.click(within(launcher).getByRole("button", { name: "Connect SSH" }));
  expect(onNewTerminal).toHaveBeenCalledTimes(1);
  expect(onNewTerminalInDirectory).toHaveBeenCalledTimes(1);
  expect(onOpenSsh).toHaveBeenCalledTimes(1);
  expect(within(screen.getByRole("region", { name: "Recent folders" })).getByRole("button", { name: "project" })).toBeTruthy();
  const host = await screen.findByRole("button", { name: "lab box" });
  fireEvent.click(host);
  await waitFor(() => expect(useUIStore.getState()).toMatchObject({
    overlay: "ssh",
    sshPrefill: { host: "box.example", port: 22, user: "deploy" },
  }));
  useUIStore.setState({ overlay: null, sshPrefill: null });
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

test("session rename does not commit on an IME Enter keydown", () => {
  const session = localSession("rename-ime", "/tmp", { customTitle: "Original" });
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  render(
    <Sidebar
      sessions={[session]}
      activeSessionId={session.id}
      onSelectSession={vi.fn()}
    />,
  );

  fireEvent.doubleClick(screen.getByRole("button", { name: /Original/ }));
  const input = screen.getByDisplayValue("Original");
  fireEvent.change(input, { target: { value: "Composing" } });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });

  expect(screen.getByDisplayValue("Composing")).toBeTruthy();
  expect(useSessionsStore.getState().sessions[0].customTitle).toBe("Original");
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

  const toggle = await screen.findByRole("button", { name: /SSH hosts · 1/ });
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

  fireEvent.click(await screen.findByRole("button", { name: /SSH hosts · 1/ }));
  fireEvent.click(await screen.findByRole("button", { name: "other box" }));
  await waitFor(() => expect(useUIStore.getState().overlay).toBe("ssh"));
});

test("a saved host that matches an ssh config entry is listed once", async () => {
  mockIPC((command) => {
    if (command === "ssh_hosts_load") {
      return [{ id: "saved-qa", label: "qa-local", host: "127.0.0.1", port: 2222, user: "qauser", identity_file: "" }];
    }
    if (command === "ssh_hosts_import_config") {
      return { imported: [{ id: "ssh-config-qa", label: "qa-local", host: "127.0.0.1", port: 2222, user: "qauser", identity_file: "~/.ssh/id_qa" }], skipped: 0, diagnostics: [] };
    }
    return undefined;
  });
  render(<Sidebar sessions={[sshSession("live", "/root")]} activeSessionId="live" onSelectSession={vi.fn()} />);

  // One row, so the count is 1 rather than 2 (saved + config).
  fireEvent.click(await screen.findByRole("button", { name: /SSH hosts · 1/ }));
  const rows = await screen.findAllByRole("button", { name: "qa-local" });
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain("Saved · SSH config");
  fireEvent.click(rows[0]);
  await waitFor(() => expect(useUIStore.getState().overlay).toBe("ssh"));
  expect(useUIStore.getState().sshPrefill).toMatchObject({ host: "127.0.0.1", port: 2222, user: "qauser", identityFile: "~/.ssh/id_qa" });
});

test("session card marks a running multiplexer and explains where pane status comes from", () => {
  render(
    <Sidebar
      sessions={[sshSession("herdr", "/srv", "box.example", { runState: "running", lastCommand: "herdr session attach work" })]}
      activeSessionId="herdr"
      onSelectSession={vi.fn()}
    />,
  );

  const chip = screen.getByText("HerdR");
  expect(chip.getAttribute("title")).toMatch(/HerdR is running: Agent status/);
  expect(screen.getByRole("button", { name: /HerdR is running/ })).toBeTruthy();
});

test("local HerdR chip reflects blocked panes reported by the HerdR socket API", async () => {
  mockIPC((cmd, args) => cmd === "multiplexer_status" && (args as { kind?: string }).kind === "herdr"
    ? { kind: "herdr", panes: [
      { paneId: "w1:p1", focused: true, agent: "claude", agentStatus: "blocked", cwd: "/repo" },
      { paneId: "w1:p2", focused: false, agent: "codex", agentStatus: "working", cwd: "/repo" },
    ] }
    : null);
  render(
    <Sidebar
      sessions={[localSession("herdr-local", "/repo", { runState: "running", lastCommand: "herdr" })]}
      activeSessionId="herdr-local"
      onSelectSession={vi.fn()}
    />,
  );

  const chip = await screen.findByText("HerdR · 1 blocked");
  expect(chip.getAttribute("data-herdr-blocked")).toBe("true");
  expect(chip.getAttribute("title")).toBe("HerdR panes: 1 blocked, 1 working, 0 done. Focused pane: /repo");
});
