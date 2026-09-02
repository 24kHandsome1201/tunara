import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SessionRemediationNotice } from "@/ui/SessionRemediationNotice";
import type { Session } from "@/ui/types";
import { handleSshTransportLost } from "@/modules/ssh/auto-reconnect";

const local: Session = {
  id: "local-owner", title: "Local", dir: "/same", branch: "", runState: "idle", updatedAt: 1,
};
const remote: Session = {
  id: "ssh-owner", title: "SSH", dir: "/same", branch: "", runState: "idle", updatedAt: 1,
  remote: { host: "target.internal", port: 2202, user: "deploy", autoReconnect: true },
  ptyId: 42,
  transportGeneration: "generation-42",
};

test("local and SSH resources with the same path stay origin-scoped", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => { calls.push({ command, payload }); return undefined; });
  useSessionsStore.setState({ sessions: [local, remote], activeSessionId: local.id });
  useUIStore.setState({ readers: {}, focusedPaneId: null });

  await openResource(resourceRefForSession(local, "/same/app.ts", 7, 3));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    command: "open_in_editor",
    payload: { path: "/same/app.ts", line: 7, column: 3 },
  });

  await openResource(resourceRefForSession(remote, "/same/app.ts", 11, 5));
  expect(calls).toHaveLength(1);
  expect(useSessionsStore.getState().activeSessionId).toBe(remote.id);
  expect(useUIStore.getState().readers[remote.id]?.current).toMatchObject({
    filePath: "/same/app.ts",
    line: 11,
    column: 5,
  });
});

test("a stale SSH resource binding fails closed without a local editor fallback", async () => {
  const calls: string[] = [];
  mockIPC((command) => { calls.push(command); return undefined; });
  useSessionsStore.setState({ sessions: [remote], activeSessionId: remote.id });
  const stale = resourceRefForSession(remote, "/same/app.ts");
  useSessionsStore.setState({ sessions: [{ ...remote, transportGeneration: "replacement-generation" }] });

  await expect(openResource(stale)).rejects.toThrow("stale SSH resource binding");
  expect(calls).not.toContain("open_in_editor");
});

test("typed remediation preserves focus, opens a secret-free replacement, and rejects stale actions", () => {
  const needsCredentials: Session = {
    ...remote,
    connection: { transport: "ssh", phase: "needsUserAction", source: "user", updatedAt: 2, reason: "auth" },
  };
  useSessionsStore.setState({ sessions: [needsCredentials], activeSessionId: needsCredentials.id });
  useUIStore.setState({ overlay: null, sshPrefill: null, toasts: [] });
  const outside = document.createElement("button");
  document.body.append(outside);
  outside.focus();
  const view = render(<SessionRemediationNotice session={needsCredentials} />);
  expect(document.activeElement).toBe(outside);

  fireEvent.click(screen.getByRole("button", { name: "Provide credentials" }));
  expect(useUIStore.getState().sshPrefill).toMatchObject({
    host: "target.internal",
    port: 2202,
    user: "deploy",
    autoReconnect: true,
    reconnectSessionId: needsCredentials.id,
  });

  act(() => {
    useUIStore.setState({ overlay: null, sshPrefill: null });
    useSessionsStore.setState({ sessions: [{ ...needsCredentials, transportGeneration: "replacement-generation" }] });
  });
  fireEvent.click(screen.getByRole("button", { name: "Provide credentials" }));
  expect(useUIStore.getState().sshPrefill).toBeNull();
  const toasts = useUIStore.getState().toasts;
  expect(toasts[toasts.length - 1]?.title).toBe("This recovery action is stale");

  view.unmount();
  outside.remove();
});

test("non-auto transport loss captures forwarding intent before offering manual remediation", async () => {
  const manual = { ...remote, remote: { ...remote.remote!, autoReconnect: false } };
  const intent = {
    kind: "dynamic" as const,
    oldRuleId: "dynamic-1",
    oldBinding: { logicalSessionId: manual.id, physicalPtyId: 42, transportGeneration: "generation-42" },
    bindHost: "127.0.0.1",
    requestedLocalPort: 0,
    oldActualLocalPort: 49152,
  };
  mockIPC((command) => command === "ssh_forwarding_reconnect_snapshot" ? [intent] : undefined);
  useSessionsStore.setState({ sessions: [manual], activeSessionId: manual.id });

  handleSshTransportLost(manual.id, "generation-42", () => {});

  await waitFor(() => expect(useSessionsStore.getState().sessions[0].connection?.phase).toBe("needsUserAction"));
  expect(useSessionsStore.getState().sessions[0].sshReconnectForwards).toEqual([intent]);
  expect(useSessionsStore.getState().sessions[0].sshReconnectLifecycle).toBe(1);
});
