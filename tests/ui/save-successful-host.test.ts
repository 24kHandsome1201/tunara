import { mockIPC } from "@tauri-apps/api/mocks";
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { sshHostProfileFromSuccessfulConnect } from "@/modules/ssh/save-successful-host";
import { useSessionsStore } from "@/state/sessions";
import type { Session } from "@/ui/types";

function remoteSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ssh-1",
    title: "deploy@lab.example",
    dir: "deploy@lab.example",
    branch: "",
    runState: "idle",
    updatedAt: 1,
    remote: { host: "lab.example", port: 22, user: "deploy", authMethod: "auto" },
    connection: { transport: "ssh", phase: "connecting", source: "backend", updatedAt: 1 },
    pendingSavedHost: sshHostProfileFromSuccessfulConnect(
      { host: "lab.example", port: 22, user: "deploy", authMethod: "auto" },
      "deploy@lab.example",
      [],
    ),
    ...overrides,
  };
}

describe("save SSH host after connection success", () => {
  afterEach(() => {
    useSessionsStore.setState({ sessions: [], activeSessionId: null });
  });

  test("builds a secret-free profile from the successful connect snapshot", () => {
    const profile = sshHostProfileFromSuccessfulConnect(
      {
        host: "prod.example",
        port: 2222,
        user: "deploy",
        authMethod: "password",
        route: { profileId: "jump", jump: { host: "jump.example", port: 22, user: "ops", authMethod: "agent" } },
      },
      "deploy@prod.example",
      [],
    );
    expect(profile).toMatchObject({
      label: "deploy@prod.example",
      host: "prod.example",
      port: 2222,
      user: "deploy",
      authMethod: "password",
      identityFile: "",
      certificateFile: "",
      proxyJumpProfileId: "jump",
    });
    expect(profile).not.toHaveProperty("password");
  });

  test("saves only when the session reports ready, not when it fails", async () => {
    const saves: unknown[] = [];
    mockIPC((command, payload) => {
      if (command === "ssh_hosts_save") {
        saves.push((payload as { profile: unknown }).profile);
        return [(payload as { profile: unknown }).profile];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    useSessionsStore.setState({ sessions: [remoteSession()], activeSessionId: "ssh-1" });
    useSessionsStore.getState().handleConnectionEvent("ssh-1", {
      type: "failed",
      transport: "ssh",
      reason: "auth",
    });
    expect(saves).toHaveLength(0);
    expect(useSessionsStore.getState().sessions[0].pendingSavedHost).toBeUndefined();

    useSessionsStore.setState({ sessions: [remoteSession()], activeSessionId: "ssh-1" });
    useSessionsStore.getState().handleConnectionEvent("ssh-1", {
      type: "backendPhase",
      transport: "ssh",
      phase: "ready",
    });
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(useSessionsStore.getState().sessions[0].pendingSavedHost).toBeUndefined();
    expect(useSessionsStore.getState().sessions[0].connection?.phase).toBe("ready");
  });
});
