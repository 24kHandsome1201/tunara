import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { takeSshCredentials } from "@/modules/ssh/pending-credentials";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SshConnect } from "@/ui/overlays/SshConnect";

function mockEmptySources() {
  mockIPC((command) => {
    if (command === "ssh_hosts_load") return [];
    if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0 };
    throw new Error(`unexpected command: ${command}`);
  });
}

function SshDialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open SSH</button>
      {open && <SshConnect onClose={() => setOpen(false)} />}
    </>
  );
}

describe("SSH connection sheet", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null });
    useUIStore.setState({ overlay: "ssh", sshPrefill: null, inspectorTab: "files" });
  });

  afterEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null });
  });

  test("exposes a described modal, closes on Escape, and restores opener focus", async () => {
    mockEmptySources();
    render(<SshDialogHarness />);
    const opener = screen.getByRole("button", { name: "Open SSH" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "SSH Connection" });
    expect(dialog.getAttribute("aria-describedby")).toBe("ssh-connect-subtitle");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Host")));

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    dialog.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  test("requires an explicit method and keeps Password strictly password-only", async () => {
    mockEmptySources();
    render(<SshConnect onClose={vi.fn()} />);

    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /^Password/ }));
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByLabelText("Private key")).toBeNull();
    expect(screen.queryByLabelText("Key passphrase (optional)")).toBeNull();
    expect(screen.getByText(/will not read a private key or contact SSH Agent/i)).toBeTruthy();

    const secret = ["single", "attempt", "credential"].join("-");
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "password.example" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "deploy" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: secret } });
    await waitFor(() => expect(connect.disabled).toBe(false));
    fireEvent.click(connect);

    const [session] = useSessionsStore.getState().sessions;
    expect(session.remote).toEqual({
      host: "password.example",
      port: 22,
      user: "deploy",
      authMethod: "password",
      injectShellIntegration: true,
    });
    expect(useUIStore.getState().inspectorTab).toBe("overview");
    expect(JSON.stringify(session)).not.toContain(secret);
    expect(takeSshCredentials(session.id)?.password).toBe(secret);
    expect(takeSshCredentials(session.id)).toBeUndefined();
  });

  test("keeps an invalid Port description on the full endpoint row in a narrow window", () => {
    mockEmptySources();
    useUIStore.setState({ viewportWidth: 640 });
    render(<SshConnect onClose={vi.fn()} />);

    const port = screen.getByLabelText("Port");
    fireEvent.change(port, { target: { value: "99999" } });
    const error = screen.getByText("Port must be a number between 1 and 65535");
    const endpoint = document.getElementById("ssh-endpoint-label")?.parentElement;

    expect(error.getAttribute("role")).toBe("alert");
    expect(port.getAttribute("aria-invalid")).toBe("true");
    expect(port.getAttribute("aria-describedby")).toBe("ssh-connect-port-error");
    expect(error.textContent).toBe("Port must be a number between 1 and 65535");
    expect(error.parentElement).toBe(endpoint);
    expect(error.parentElement).not.toBe(port.parentElement);
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("a config key suggestion is discarded when Password is selected and never saved", async () => {
    const saves: Array<Record<string, unknown>> = [];
    mockIPC((command, payload) => {
      if (command === "ssh_hosts_load") return [];
      if (command === "ssh_hosts_import_config") {
        return {
          imported: [{
            id: "ssh-config-prod",
            label: "prod",
            host: "prod.example",
            port: 2222,
            user: "deploy",
            auth_method: "key",
            identity_file: "~/.ssh/id_prod",
            certificate_file: "~/.ssh/id_prod-cert.pub",
          }],
          skipped: 0,
        };
      }
      if (command === "ssh_hosts_save") {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        saves.push(profile);
        return [profile];
      }
      throw new Error(`unexpected command: ${command}`);
    });
    render(<SshConnect onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /prod.*~\/.ssh\/config/i }));
    expect((screen.getByRole("radio", { name: /^Private key/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Private key") as HTMLInputElement).value).toBe("~/.ssh/id_prod");
    expect((screen.getByLabelText("Certificate file (optional)") as HTMLInputElement).value).toBe("~/.ssh/id_prod-cert.pub");

    fireEvent.click(screen.getByRole("radio", { name: /^Password/ }));
    expect(screen.queryByLabelText("Private key")).toBeNull();
    const secret = ["not", "for", "profile"].join("-");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: secret } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Save as connection profile/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      host: "prod.example",
      port: 2222,
      user: "deploy",
      auth_method: "password",
      identity_file: "",
      certificate_file: "",
    });
    expect(saves[0]).not.toHaveProperty("password");
    expect(saves[0]).not.toHaveProperty("key_passphrase");
    expect(JSON.stringify(saves[0])).not.toContain(secret);
    const [session] = useSessionsStore.getState().sessions;
    expect(takeSshCredentials(session.id)?.password).toBe(secret);
  });

  test("reconnecting publishes no stale PTY and remounts a fresh terminal parser", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "ssh_hosts_load") return [];
      if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0 };
      if (command === "ssh_forwarding_reconnect_snapshot") return [];
      throw new Error(`unexpected command: ${command}`);
    });
    useSessionsStore.setState({
      sessions: [{
        id: "live-ssh",
        title: "deploy@old.example",
        dir: "/srv/app",
        branch: "main",
        runState: "idle",
        updatedAt: 1,
        reconnectNonce: 4,
        terminalMountNonce: 4,
        ptyId: 91,
        transportGeneration: "ssh:old",
        remote: { host: "old.example", port: 22, user: "deploy", authMethod: "agent" },
        connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
      }],
      activeSessionId: "live-ssh",
    });
    useUIStore.setState({
      overlay: "ssh",
      sshPrefill: {
        host: "old.example",
        port: 22,
        user: "deploy",
        authMethod: "agent",
        reconnectSessionId: "live-ssh",
      },
      inspectorTab: "files",
    });
    render(<SshConnect onClose={vi.fn()} />);

    const reconnect = screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement;
    await waitFor(() => expect(reconnect.disabled).toBe(false));
    fireEvent.click(reconnect);

    await waitFor(() => expect(useSessionsStore.getState().sessions[0].transportGeneration).toBeUndefined());
    const session = useSessionsStore.getState().sessions[0];
    expect(session.remote).toEqual({
      host: "old.example",
      port: 22,
      user: "deploy",
      authMethod: "agent",
      injectShellIntegration: true,
    });
    expect(session.ptyId).toBeUndefined();
    expect(session.transportGeneration).toBeUndefined();
    expect(session.connection?.phase).toBe("reconnecting");
    expect(session.reconnectNonce).toBe(5);
    expect(session.terminalMountNonce).toBe(5);
    expect(calls).toContain("ssh_forwarding_reconnect_snapshot");
  });

  test("a reconnect edited to another endpoint opens a new session and preserves the old boundary", async () => {
    mockEmptySources();
    useSessionsStore.setState({
      sessions: [{
        id: "old-boundary",
        title: "deploy@old.example",
        dir: "/srv/app",
        branch: "main",
        runState: "failed",
        updatedAt: 1,
        remote: { host: "old.example", port: 22, user: "deploy", authMethod: "agent" },
        connection: { transport: "ssh", phase: "disconnected", source: "transport", updatedAt: 1 },
      }],
      activeSessionId: "old-boundary",
    });
    useUIStore.setState({
      overlay: "ssh",
      sshPrefill: {
        host: "new.example",
        port: 2222,
        user: "ops",
        authMethod: "agent",
        reconnectSessionId: "old-boundary",
      },
    });
    render(<SshConnect onClose={vi.fn()} />);
    const reconnect = screen.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement;
    await waitFor(() => expect(reconnect.disabled).toBe(false));
    fireEvent.click(reconnect);

    const sessions = useSessionsStore.getState().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((candidate) => candidate.id === "old-boundary")).toMatchObject({
      remote: { host: "old.example" },
      dir: "/srv/app",
      connection: { phase: "disconnected" },
    });
    expect(sessions.find((candidate) => candidate.id !== "old-boundary")).toMatchObject({
      remote: { host: "new.example", port: 2222, user: "ops" },
    });
  });

  test("routed saved and config profiles are visible but fail closed when their jump is missing", async () => {
    mockIPC((command) => {
      if (command === "ssh_hosts_load") {
        return [{
          id: "saved-target",
          label: "saved routed",
          host: "saved-private.example",
          port: 22,
          user: "deploy",
          identity_file: "",
          proxy_jump_profile_id: "saved-jump",
        }];
      }
      if (command === "ssh_hosts_import_config") {
        return {
          imported: [{
            id: "config-target",
            label: "config routed",
            host: "config-private.example",
            port: 22,
            user: "deploy",
            identity_file: "",
            proxy_jump_profile_id: "config-jump",
          }],
          skipped: 0,
          diagnostics: [],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    const saved = await screen.findByRole("button", { name: /saved routed/i });
    expect(screen.getByRole("button", { name: /config routed/i })).toBeTruthy();
    fireEvent.click(saved);
    expect(screen.getByText(/ProxyJump profile is missing/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
  });

  test("connects a routed config target with an explicit one-shot jump method and no persisted secrets", async () => {
    const jumpSecret = "jump-secret-once";
    mockIPC((command) => {
      if (command === "ssh_hosts_load") {
        return [{ id: "jump", label: "Bastion", host: "jump.example", port: 22, user: "ops", identity_file: "" }];
      }
      if (command === "ssh_hosts_import_config") {
        return {
          imported: [{
            id: "target",
            label: "Routed target",
            host: "target.internal",
            port: 22,
            user: "deploy",
            auth_method: "agent",
            identity_file: "",
            proxy_jump_profile_id: "jump",
          }],
          skipped: 0,
          diagnostics: [],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Routed target/i }));
    const jumpMethods = screen.getByRole("radiogroup", { name: "Jump-hop authentication method" });
    fireEvent.click(within(jumpMethods).getByRole("radio", { name: "Password" }));
    fireEvent.change(screen.getByLabelText("Jump-hop password"), { target: { value: jumpSecret } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const [session] = useSessionsStore.getState().sessions;
    expect(session.remote).toMatchObject({
      host: "target.internal",
      authMethod: "agent",
      route: {
        profileId: "jump",
        jump: { host: "jump.example", user: "ops", authMethod: "password" },
      },
    });
    expect(JSON.stringify(session)).not.toContain(jumpSecret);
    expect(takeSshCredentials(session.id)?.jumpPassword).toBe(jumpSecret);
    expect(takeSshCredentials(session.id)).toBeUndefined();
  });

  test("saving a direct config target does not flatten a same-endpoint routed profile", async () => {
    const saves: Array<Record<string, unknown>> = [];
    mockIPC((command, payload) => {
      if (command === "ssh_hosts_load") return [
        { id: "jump", label: "Bastion", host: "jump.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" },
        { id: "saved-routed", label: "Saved routed", host: "target.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "", proxy_jump_profile_id: "jump" },
      ];
      if (command === "ssh_hosts_import_config") return {
        imported: [{ id: "config-direct", label: "Config direct", host: "target.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "" }],
        skipped: 0,
        diagnostics: [],
      };
      if (command === "ssh_hosts_save") {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        saves.push(profile);
        return [profile];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Config direct/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Save as connection profile/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].id).not.toBe("saved-routed");
    expect(saves[0].proxy_jump_profile_id).toBe("");
  });

  test("saving a routed config target does not reroute a same-endpoint direct profile", async () => {
    const saves: Array<Record<string, unknown>> = [];
    mockIPC((command, payload) => {
      if (command === "ssh_hosts_load") return [
        { id: "saved-direct", label: "Saved direct", host: "target.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "" },
        { id: "jump", label: "Bastion", host: "jump.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" },
      ];
      if (command === "ssh_hosts_import_config") return {
        imported: [{ id: "config-routed", label: "Config routed", host: "target.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "", proxy_jump_profile_id: "jump" }],
        skipped: 0,
        diagnostics: [],
      };
      if (command === "ssh_hosts_save") {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        saves.push(profile);
        return [profile];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Config routed/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Save as connection profile/ }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].id).not.toBe("saved-direct");
    expect(saves[0].proxy_jump_profile_id).toBe("jump");
  });

  test("switching a configured route back to Direct discards jump-hop credentials", async () => {
    const jumpSecret = "discard-this-jump-secret";
    mockIPC((command) => {
      if (command === "ssh_hosts_load") return [
        { id: "jump", label: "Bastion", host: "jump.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" },
      ];
      if (command === "ssh_hosts_import_config") return { imported: [], skipped: 0, diagnostics: [] };
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    const routeSelector = await screen.findByLabelText("Direct or ProxyJump profile");
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "target.internal" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "deploy" } });
    fireEvent.click(screen.getByRole("radio", { name: /^SSH Agent/ }));
    fireEvent.change(routeSelector, { target: { value: "jump" } });
    const jumpMethods = await screen.findByRole("radiogroup", { name: "Jump-hop authentication method" });
    fireEvent.click(within(jumpMethods).getByRole("radio", { name: "Password" }));
    fireEvent.change(screen.getByLabelText("Jump-hop password"), { target: { value: jumpSecret } });
    fireEvent.change(routeSelector, { target: { value: "" } });

    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    await waitFor(() => expect(connect.disabled).toBe(false));
    fireEvent.click(connect);
    const [session] = useSessionsStore.getState().sessions;
    expect(session.remote?.route).toBeUndefined();
    expect(takeSshCredentials(session.id)).toBeUndefined();
  });

  test("shows typed config diagnostics and invalidates a routed import before refresh settles", async () => {
    let importCount = 0;
    let resolveRefresh!: (value: unknown) => void;
    mockIPC((command) => {
      if (command === "ssh_hosts_load") return [];
      if (command === "ssh_hosts_import_config") {
        importCount += 1;
        if (importCount > 1) return new Promise((resolve) => { resolveRefresh = resolve; });
        return {
          imported: [
            { id: "jump", label: "Config jump", host: "jump.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" },
            { id: "target", label: "Config target", host: "target.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "", proxy_jump_profile_id: "jump" },
          ],
          skipped: 1,
          diagnostics: [{ source: "/home/test/.ssh/config", line: 17, alias: "unsafe", code: "unsupported_active_directive", directive: "ProxyCommand", severity: "error" }],
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Config target/i }));
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("2 available, 1 skipped");
    fireEvent.click(screen.getByText("SSH config diagnostics"));
    expect(screen.getByText(/error · \/home\/test\/\.ssh\/config:17 · unsafe · unsupported_active_directive · ProxyCommand/)).toBeTruthy();
    expect(screen.getByText(/%h, %n, %p, %r, and %u/)).toBeTruthy();
    expect(screen.getByText("ProxyCommand and Match exec are never executed.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh ~/.ssh/config" }));
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
    resolveRefresh({ imported: [], skipped: 0, diagnostics: [] });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Config target/i })).toBeNull());
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
  });

  test("renders ambiguous and routed-jump resolver rejections without a direct fallback", async () => {
    mockIPC((command) => {
      if (command === "ssh_hosts_load") {
        return [
          { id: "dup", label: "Saved duplicate", host: "one.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" },
          { id: "tail", label: "Tail", host: "tail.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" },
          { id: "routed-jump", label: "Routed jump", host: "routed.example", port: 22, user: "ops", auth_method: "agent", identity_file: "", proxy_jump_profile_id: "tail" },
          { id: "ambiguous-target", label: "Ambiguous target", host: "a.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "", proxy_jump_profile_id: "dup" },
          { id: "multihop-target", label: "Multi-hop target", host: "b.internal", port: 22, user: "deploy", auth_method: "agent", identity_file: "", proxy_jump_profile_id: "routed-jump" },
        ];
      }
      if (command === "ssh_hosts_import_config") {
        return { imported: [{ id: "dup", label: "Config duplicate", host: "two.example", port: 22, user: "ops", auth_method: "agent", identity_file: "" }], skipped: 0, diagnostics: [] };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<SshConnect onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Ambiguous target/i }));
    expect(screen.getByText(/More than one ProxyJump profile/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Multi-hop target/i }));
    expect(screen.getByText(/routed profile cannot be used as a jump hop/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
    expect(useSessionsStore.getState().sessions).toHaveLength(0);
  });
});
