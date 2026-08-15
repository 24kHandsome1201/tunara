import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ForwardingPanel } from "@/modules/ssh/ForwardingPanel";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import type { Session } from "@/ui/types";

const binding: SessionBindingV1 = {
  logicalSessionId: "forward-session",
  physicalPtyId: 42,
  transportGeneration: "tg-forward",
};

const session: Session = {
  id: "forward-session",
  title: "Forwarding",
  dir: "/srv/app",
  branch: "main",
  runState: "idle",
  updatedAt: 1,
  ptyId: 42,
  transportGeneration: "tg-forward",
  remote: { host: "example.com", port: 22, user: "deploy", authMethod: "agent" },
  connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
};

beforeEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("starts and stops loopback-only local forwarding with requested and actual ports", async () => {
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  let localRules: Array<Record<string, unknown>> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload: payload as Record<string, unknown> });
    if (command === "ssh_local_forward_list") return localRules;
    if (command === "ssh_dynamic_forward_list" || command === "ssh_remote_forward_list") return [];
    if (command === "ssh_local_forward_start") {
      localRules = [{
        ruleId: "lf-1",
        binding,
        bindHost: "127.0.0.1",
        localPort: 49152,
        requestedLocalPort: 0,
        recreateOnReconnect: true,
        targetHost: "db.internal",
        targetPort: 5432,
      }];
      return localRules[0];
    }
    if (command === "ssh_local_forward_stop") {
      localRules = [];
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });

  render(<ForwardingPanel binding={binding} session={session} />);
  await waitFor(() => expect(screen.getByText("No active forwarding listeners")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Target host"), { target: { value: "db.internal" } });
  fireEvent.change(screen.getByLabelText("Target port"), { target: { value: "5432" } });
  fireEvent.click(screen.getByLabelText("Recreate this listener after a successful replacement-shell reconnect"));
  fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

  expect(await screen.findByText("127.0.0.1:49152 → db.internal:5432")).toBeTruthy();
  expect(screen.getByText("ephemeral port")).toBeTruthy();
  const start = calls.find((call) => call.command === "ssh_local_forward_start");
  expect(start?.payload).toMatchObject({
    binding,
    bindHost: "127.0.0.1",
    localPort: 0,
    targetHost: "db.internal",
    targetPort: 5432,
    recreateOnReconnect: true,
  });

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(screen.getByText("No active forwarding listeners")).toBeTruthy());
  expect(calls.find((call) => call.command === "ssh_local_forward_stop")?.payload).toEqual({
    binding,
    ruleId: "lf-1",
  });
});

test("starts dynamic SOCKS5 forwarding without exposing Agent forwarding", async () => {
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  let dynamicRules: Array<Record<string, unknown>> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload: payload as Record<string, unknown> });
    if (command === "ssh_local_forward_list" || command === "ssh_remote_forward_list") return [];
    if (command === "ssh_dynamic_forward_list") return dynamicRules;
    if (command === "ssh_dynamic_forward_start") {
      dynamicRules = [{
        ruleId: "df-1",
        binding,
        bindHost: "127.0.0.1",
        localPort: 1080,
        requestedLocalPort: 1080,
        recreateOnReconnect: false,
      }];
      return dynamicRules[0];
    }
    if (command === "ssh_dynamic_forward_stop") {
      dynamicRules = [];
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });

  render(<ForwardingPanel binding={binding} session={session} />);
  await screen.findByText("No active forwarding listeners");
  fireEvent.click(screen.getByLabelText("Dynamic (SOCKS5)"));
  fireEvent.change(screen.getByLabelText("Local port"), { target: { value: "1080" } });
  fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

  await waitFor(() => expect(calls.some((call) => call.command === "ssh_dynamic_forward_start")).toBe(true));
  expect(calls.find((call) => call.command === "ssh_dynamic_forward_start")?.payload).toMatchObject({
    binding,
    bindHost: "127.0.0.1",
    localPort: 1080,
  });
  expect(screen.queryByRole("radio", { name: /agent/i })).toBeNull();

  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await waitFor(() => expect(screen.getByText("No active forwarding listeners")).toBeTruthy());
  expect(calls.find((call) => call.command === "ssh_dynamic_forward_stop")?.payload).toEqual({
    binding,
    ruleId: "df-1",
  });
});

test("shows only allowlisted failures and explains replacement-shell reconnect", async () => {
  mockIPC((command) => {
    if (command === "ssh_local_forward_list" || command === "ssh_dynamic_forward_list" || command === "ssh_remote_forward_list") return [];
    if (command === "ssh_local_forward_start") throw new Error("SSH_FORWARDING_FIXED_PORT_UNAVAILABLE SECRET-CANARY");
    throw new Error(`unexpected command: ${command}`);
  });

  const view = render(<ForwardingPanel binding={binding} session={session} />);
  await screen.findByText("No active forwarding listeners");
  fireEvent.change(screen.getByLabelText("Local port"), { target: { value: "2222" } });
  fireEvent.change(screen.getByLabelText("Target host"), { target: { value: "db.internal" } });
  fireEvent.change(screen.getByLabelText("Target port"), { target: { value: "5432" } });
  fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The requested local port is unavailable");
  expect(view.container.textContent).not.toContain("SECRET-CANARY");

  view.rerender(<ForwardingPanel binding={null} session={{
    ...session,
    ptyId: undefined,
    transportGeneration: undefined,
    connection: { transport: "ssh", phase: "needsUserAction", source: "user", updatedAt: 2, reason: "auth" },
  }} />);
  expect(screen.getByRole("alert").textContent).toContain("Reconnect needs your action");
  expect(screen.getByText(/cannot restore the old shell or replay its input/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start forwarding" })).toBeNull();
});

test.each(["resolve", "reject"] as const)("stale generation list calls cannot affect the current panel when they %s", async (settlement) => {
  const oldLocal = deferred<Array<Record<string, unknown>>>();
  const oldDynamic = deferred<Array<Record<string, unknown>>>();
  const nextBinding = { ...binding, physicalPtyId: 43, transportGeneration: "tg-next" };
  mockIPC((command, payload) => {
    if (command !== "ssh_local_forward_list" && command !== "ssh_dynamic_forward_list" && command !== "ssh_remote_forward_list") {
      throw new Error(`unexpected command: ${command}`);
    }
    const current = (payload as { binding: SessionBindingV1 }).binding;
    if (current.transportGeneration === binding.transportGeneration) {
      return command === "ssh_local_forward_list" ? oldLocal.promise : oldDynamic.promise;
    }
    if (command !== "ssh_local_forward_list") return [];
    return command === "ssh_local_forward_list" ? [{
      ruleId: "new-rule", binding: nextBinding, bindHost: "127.0.0.1", localPort: 2200,
      requestedLocalPort: 2200, recreateOnReconnect: false, targetHost: "new.internal", targetPort: 22,
    }] : [];
  });

  const view = render(<ForwardingPanel binding={binding} session={session} />);
  view.rerender(<ForwardingPanel binding={nextBinding} session={{ ...session, ptyId: 43, transportGeneration: "tg-next" }} />);
  expect(await screen.findByText("127.0.0.1:2200 → new.internal:22")).toBeTruthy();

  if (settlement === "resolve") {
    oldLocal.resolve([{ ruleId: "stale-rule" }]);
    oldDynamic.resolve([]);
  } else {
    oldLocal.reject(new Error("stale failure"));
    oldDynamic.resolve([]);
  }
  await Promise.allSettled([oldLocal.promise, oldDynamic.promise]);
  await waitFor(() => expect(screen.getByText("127.0.0.1:2200 → new.internal:22")).toBeTruthy());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Loading forwarding listeners…")).toBeNull();
  expect(screen.queryByText(/stale-rule/)).toBeNull();
});

test.each(["start", "stop"] as const)("a stale pending %s rejection cannot update or refresh the next generation", async (mutation) => {
  const pendingMutation = deferred<unknown>();
  const nextBinding = { ...binding, physicalPtyId: 43, transportGeneration: "tg-next" };
  const listCalls: string[] = [];
  const stopBindings: SessionBindingV1[] = [];
  mockIPC((command, payload) => {
    if (command === "ssh_local_forward_start" || command === "ssh_local_forward_stop") {
      if (command === "ssh_local_forward_stop") {
        stopBindings.push((payload as { binding: SessionBindingV1 }).binding);
      }
      return pendingMutation.promise;
    }
    if (command === "ssh_local_forward_list" || command === "ssh_dynamic_forward_list" || command === "ssh_remote_forward_list") {
      const current = (payload as { binding: SessionBindingV1 }).binding;
      listCalls.push(`${command}:${current.transportGeneration}`);
      if (command !== "ssh_local_forward_list") return [];
      if (current.transportGeneration === binding.transportGeneration) {
        return mutation === "stop" ? [{
          ruleId: "old-rule", binding, bindHost: "127.0.0.1", localPort: 2100,
          requestedLocalPort: 2100, recreateOnReconnect: false, targetHost: "old.internal", targetPort: 22,
        }] : [];
      }
      return [{
        ruleId: "new-rule", binding: nextBinding, bindHost: "127.0.0.1", localPort: 2200,
        requestedLocalPort: 2200, recreateOnReconnect: false, targetHost: "new.internal", targetPort: 22,
      }];
    }
    throw new Error(`unexpected command: ${command}`);
  });

  const view = render(<ForwardingPanel binding={binding} session={session} />);
  if (mutation === "start") {
    await screen.findByText("No active forwarding listeners");
    fireEvent.change(screen.getByLabelText("Target host"), { target: { value: "old.internal" } });
    fireEvent.change(screen.getByLabelText("Target port"), { target: { value: "22" } });
    fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));
  } else {
    await screen.findByText("127.0.0.1:2100 → old.internal:22");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopBindings).toEqual([binding]);
  }
  await waitFor(() => expect(screen.getByText("Updating forwarding rules…")).toBeTruthy());

  view.rerender(<ForwardingPanel binding={nextBinding} session={{ ...session, ptyId: 43, transportGeneration: "tg-next" }} />);
  expect(await screen.findByText("127.0.0.1:2200 → new.internal:22")).toBeTruthy();
  expect(listCalls).toHaveLength(6);

  pendingMutation.reject(new Error("SSH_FORWARDING_INTERNAL stale mutation"));
  await pendingMutation.promise.catch(() => undefined);
  await waitFor(() => expect(screen.queryByText("Updating forwarding rules…")).toBeNull());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("127.0.0.1:2200 → new.internal:22")).toBeTruthy();
  expect(screen.queryByText(/old\.internal/)).toBeNull();
  expect(listCalls).toHaveLength(6);
});

test("starts and stops loopback-only remote forwarding onto a local target port", async () => {
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  let remoteRules: Array<Record<string, unknown>> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload: payload as Record<string, unknown> });
    if (command === "ssh_local_forward_list" || command === "ssh_dynamic_forward_list") return [];
    if (command === "ssh_remote_forward_list") return remoteRules;
    if (command === "ssh_remote_forward_start") {
      remoteRules = [{
        ruleId: "rf-1",
        binding,
        remoteBindHost: "127.0.0.1",
        remotePort: 18080,
        requestedRemotePort: 0,
        recreateOnReconnect: true,
        localTargetHost: "127.0.0.1",
        localTargetPort: 5173,
      }];
      return remoteRules[0];
    }
    if (command === "ssh_remote_forward_stop") {
      remoteRules = [];
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });

  render(<ForwardingPanel binding={binding} session={session} />);
  await screen.findByText("No active forwarding listeners");
  fireEvent.click(screen.getByLabelText("Remote"));
  fireEvent.change(screen.getByLabelText("Local target port"), { target: { value: "5173" } });
  fireEvent.click(screen.getByLabelText("Recreate this listener after a successful replacement-shell reconnect"));
  fireEvent.click(screen.getByRole("button", { name: "Start forwarding" }));

  expect(await screen.findByText("127.0.0.1:18080 → 127.0.0.1:5173")).toBeTruthy();
  expect(calls.find((call) => call.command === "ssh_remote_forward_start")?.payload).toMatchObject({
    binding,
    remoteBindHost: "127.0.0.1",
    remotePort: 0,
    localTargetHost: "127.0.0.1",
    localTargetPort: 5173,
    recreateOnReconnect: true,
  });
  expect(screen.queryByRole("radio", { name: /agent/i })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(screen.getByText("No active forwarding listeners")).toBeTruthy());
  expect(calls.find((call) => call.command === "ssh_remote_forward_stop")?.payload).toEqual({
    binding,
    ruleId: "rf-1",
  });
});
