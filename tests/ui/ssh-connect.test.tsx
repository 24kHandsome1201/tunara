import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { hasLiveSshPty, takeSshCredentials, takeSshReconnect } from "@/modules/ssh/pending-credentials";
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

describe("SSH connection sheet", () => {
  beforeEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null });
    useUIStore.setState({ overlay: "ssh", sshPrefill: null, inspectorTab: "files" });
  });

  afterEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null });
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
    });
    expect(saves[0]).not.toHaveProperty("password");
    expect(saves[0]).not.toHaveProperty("key_passphrase");
    expect(JSON.stringify(saves[0])).not.toContain(secret);
    const [session] = useSessionsStore.getState().sessions;
    expect(takeSshCredentials(session.id)?.password).toBe(secret);
  });

  test("a live reconnect stages the candidate without replacing or remounting the published session", async () => {
    mockEmptySources();
    useSessionsStore.setState({
      sessions: [{
        id: "live-ssh",
        title: "deploy@old.example",
        dir: "/srv/app",
        branch: "main",
        runState: "idle",
        updatedAt: 1,
        reconnectNonce: 4,
        ptyId: 91,
        remote: { host: "old.example", port: 22, user: "deploy", authMethod: "agent" },
        connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
      }],
      activeSessionId: "live-ssh",
    });
    useUIStore.setState({
      overlay: "ssh",
      sshPrefill: {
        host: "new.example",
        port: 2222,
        user: "ops",
        authMethod: "agent",
        reconnectSessionId: "live-ssh",
      },
      inspectorTab: "files",
    });
    render(<SshConnect onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    const session = useSessionsStore.getState().sessions[0];
    expect(session.remote).toEqual({ host: "old.example", port: 22, user: "deploy", authMethod: "agent" });
    expect(session.ptyId).toBe(91);
    expect(session.connection?.phase).toBe("ready");
    expect(session.reconnectNonce).toBe(5);
    expect(session.terminalMountNonce).toBe(4);
    expect(hasLiveSshPty({
      ...session,
      connection: { transport: "ssh", phase: "authenticating", source: "backend", updatedAt: 2 },
    })).toBe(true);
    expect(takeSshReconnect(session.id)).toEqual({
      remote: {
        host: "new.example",
        port: 2222,
        user: "ops",
        authMethod: "agent",
        injectShellIntegration: true,
      },
      credentials: {},
    });
  });
});
