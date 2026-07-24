import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import {
  openSshPty,
  SSH_DISCONNECTED_EXIT_CODE,
  type PtyEvent,
  type PtyHandlers,
  type PtySession,
} from "@/modules/terminal/lib/pty-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { ContextMenu } from "@/ui/ContextMenu";
import { SplitHandle } from "@/ui/SplitHandle";
import { PtyErrorBanner, TerminalExitBanner } from "@/ui/TerminalExitBanner";
import type { Session } from "@/ui/types";
import { createTerminalSshReconnect } from "@/ui/useTerminalSshReconnect";

test("superseded SSH channels cannot mutate the new connection generation", async () => {
  const channels: Array<Channel<PtyEvent>> = [];
  const resolveOpen: Array<(id: number) => void> = [];
  const closed: number[] = [];
  mockIPC((command, payload) => {
    if (command === "ssh_open") {
      channels.push((payload as { onEvent: Channel<PtyEvent> }).onEvent);
      return new Promise<number>((resolve) => resolveOpen.push(resolve));
    }
    if (command === "pty_close") {
      closed.push((payload as { id: number }).id);
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ hostKeyPrompts: [], keyboardInteractivePrompts: [] });

  const olderHandlers: PtyHandlers = {
    onData: vi.fn(),
    onExit: vi.fn(),
    onConnectionStatus: vi.fn(),
  };
  const newerHandlers: PtyHandlers = {
    onData: vi.fn(),
    onExit: vi.fn(),
    onConnectionStatus: vi.fn(),
  };
  const options = { host: "ssh.example", port: 22, user: "deploy", authMethod: "agent" as const };
  const olderOpen = openSshPty("generation-session", 80, 24, olderHandlers, options);
  const newerOpen = openSshPty("generation-session", 80, 24, newerHandlers, options);

  channels[1].onmessage({ type: "connectionStatus", phase: "ready" });
  channels[0].onmessage({ type: "connectionStatus", phase: "authenticating" });
  channels[0].onmessage({
    type: "hostKeyPrompt",
    promptId: "stale-host-key",
    host: "ssh.example",
    port: 22,
    fingerprint: "SHA256:stale",
    keyType: "ssh-ed25519",
    reason: "unknown",
  });

  expect(newerHandlers.onConnectionStatus).toHaveBeenCalledWith("ready");
  expect(olderHandlers.onConnectionStatus).not.toHaveBeenCalled();
  expect(useUIStore.getState().hostKeyPrompts).toEqual([]);

  resolveOpen[1](202);
  const newer = await newerOpen;
  resolveOpen[0](101);
  const older = await olderOpen;
  await older.close();
  expect(closed).toEqual([101]);

  // Closing the stale physical connection must not clear the newer logical
  // generation; its live Channel still owns status events.
  channels[1].onmessage({ type: "connectionStatus", phase: "openingShell" });
  expect(newerHandlers.onConnectionStatus).toHaveBeenLastCalledWith("openingShell");

  await newer.close();
  channels[1].onmessage({ type: "exit", code: SSH_DISCONNECTED_EXIT_CODE });
  expect(newerHandlers.onExit).not.toHaveBeenCalled();
  expect(closed).toEqual([101, 202]);
});

test("a failed replacement keeps the published SSH channel live and acknowledged", async () => {
  const channels: Array<Channel<PtyEvent>> = [];
  const opens: Array<{ resolve: (id: number) => void; reject: (error: Error) => void }> = [];
  const acknowledgements: Array<{ id: number; bytes: number }> = [];
  mockIPC((command, payload) => {
    if (command === "ssh_open") {
      channels.push((payload as { onEvent: Channel<PtyEvent> }).onEvent);
      return new Promise<number>((resolve, reject) => opens.push({ resolve, reject }));
    }
    if (command === "pty_output_ack") {
      acknowledgements.push(payload as { id: number; bytes: number });
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });

  const publishedData = vi.fn((_bytes: Uint8Array, acknowledge: () => void) => acknowledge());
  const published = openSshPty("failed-replacement-session", 80, 24, {
    onData: publishedData,
  }, { host: "old.example", user: "deploy", authMethod: "agent" });
  opens[0].resolve(301);
  await published;

  const failedReplacement = openSshPty("failed-replacement-session", 80, 24, {
    onData: vi.fn(),
  }, { host: "new.example", user: "deploy", authMethod: "agent" });
  channels[0].onmessage({ type: "data", data: "YQ==" });
  await Promise.resolve();
  expect(publishedData).toHaveBeenCalledOnce();
  expect(acknowledgements).toEqual([{ id: 301, bytes: 1 }]);

  opens[1].reject(new Error("authentication failed"));
  await expect(failedReplacement).rejects.toThrow("authentication failed");
  channels[0].onmessage({ type: "data", data: "Yg==" });
  await Promise.resolve();
  expect(publishedData).toHaveBeenCalledTimes(2);
  expect(acknowledgements).toEqual([
    { id: 301, bytes: 1 },
    { id: 301, bytes: 1 },
  ]);
});

test("overlapping failed reconnects restore the published session and its evidence", async () => {
  const opens: Array<{ reject: (error: Error) => void }> = [];
  mockIPC((command) => {
    if (command === "ssh_open") {
      return new Promise<number>((_resolve, reject) => opens.push({ reject }));
    }
    throw new Error(`unexpected command: ${command}`);
  });
  const publishedSession: Session = {
    id: "live-reconnect-session",
    title: "deploy@old.example",
    dir: "/srv/app",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    ptyId: 401,
    remote: { host: "old.example", port: 22, user: "deploy", authMethod: "agent" },
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  };
  useSessionsStore.setState({ sessions: [publishedSession], activeSessionId: publishedSession.id });
  useUIStore.setState({ toasts: [] });
  const publishedPty: PtySession = {
    id: 401,
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const ptyRef = { current: publishedPty };
  const reconnect = createTerminalSshReconnect(
    { current: publishedSession.id },
    { cols: 80, rows: 24, options: { disableStdin: false } } as never,
    ptyRef,
    { onData: vi.fn() },
    () => false,
    () => true,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );

  const first = reconnect({
    remote: { host: "first.example", port: 22, user: "deploy", authMethod: "agent" },
    credentials: {},
  });
  const second = reconnect({
    remote: { host: "second.example", port: 22, user: "deploy", authMethod: "agent" },
    credentials: {},
  });
  opens[0].reject(new Error("superseded"));
  opens[1].reject(new Error("authentication failed"));
  await Promise.all([first, second]);

  const session = useSessionsStore.getState().sessions[0];
  expect(ptyRef.current).toBe(publishedPty);
  expect(session.remote).toEqual(publishedSession.remote);
  expect(session.ptyId).toBe(401);
  expect(session.connection).toEqual(publishedSession.connection);
});

test("a successful reconnect publishes the replacement PTY and reasserts ready evidence", async () => {
  mockIPC((command) => {
    if (command === "ssh_open") return 502;
    throw new Error(`unexpected command: ${command}`);
  });
  const publishedSession: Session = {
    id: "successful-reconnect-session",
    title: "deploy@old.example",
    dir: "/srv/app",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    ptyId: 501,
    remote: { host: "old.example", port: 22, user: "deploy", authMethod: "agent" },
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  };
  useSessionsStore.setState({ sessions: [publishedSession], activeSessionId: publishedSession.id });
  const ptyRef = { current: {
    id: 501,
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } as PtySession };
  const reconnect = createTerminalSshReconnect(
    { current: publishedSession.id },
    { cols: 80, rows: 24, options: { disableStdin: true } } as never,
    ptyRef,
    { onData: vi.fn() },
    () => false,
    () => true,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );

  await reconnect({
    remote: { host: "new.example", port: 2222, user: "ops", authMethod: "agent" },
    credentials: {},
  });

  const session = useSessionsStore.getState().sessions[0];
  expect(ptyRef.current.id).toBe(502);
  expect(session.remote).toEqual({ host: "new.example", port: 2222, user: "ops", authMethod: "agent" });
  expect(session.ptyId).toBe(502);
  expect(session.connection?.phase).toBe("ready");
});

test("closing a context menu restores focus to the terminal trigger", async () => {
  const trigger = document.createElement("button");
  trigger.textContent = "terminal";
  document.body.appendChild(trigger);
  trigger.focus();
  const onClose = vi.fn();
  const view = render(
    <ContextMenu
      items={[{ id: "copy", label: "Copy", action: vi.fn() }]}
      position={{ x: 12, y: 12 }}
      onClose={onClose}
    />,
  );

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menu")));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("closing a context menu preserves focus claimed by its action", async () => {
  const trigger = document.createElement("button");
  const destination = document.createElement("button");
  document.body.append(trigger, destination);
  trigger.focus();
  const onClose = vi.fn();
  const view = render(
    <ContextMenu
      items={[{ id: "open", label: "Open", action: () => destination.focus() }]}
      position={{ x: 12, y: 12 }}
      onClose={onClose}
    />,
  );

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menu")));
  fireEvent.click(screen.getByRole("menuitem"));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(document.activeElement).toBe(destination);
  trigger.remove();
  destination.remove();
});

function SplitHandleHarness() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
      <SplitHandle
        direction="horizontal"
        path=""
        ratio={0.5}
        nodeRect={{ x: 0, y: 0, width: 1, height: 1 }}
        containerRef={containerRef}
      />
    </div>
  );
}

test("unmounting a split handle ends an active drag", () => {
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = "wait";
  document.body.style.userSelect = "text";
  const removeListener = vi.spyOn(document, "removeEventListener");
  const view = render(<SplitHandleHarness />);
  const handle = screen.getByRole("separator");
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });

  fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100, clientY: 50 });
  expect(document.body.style.cursor).toBe("col-resize");
  expect(document.body.style.userSelect).toBe("none");
  view.unmount();

  expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));
  expect(document.body.style.cursor).toBe("wait");
  expect(document.body.style.userSelect).toBe("text");

  removeListener.mockRestore();
  document.body.style.cursor = previousCursor;
  document.body.style.userSelect = previousUserSelect;
});

const remoteSession: Session = {
  id: "ssh-banner-session",
  title: "deploy@ssh.example",
  dir: "/srv/app",
  branch: "main",
  runState: "failed",
  updatedAt: 1,
  remote: {
    host: "ssh.example",
    port: 22,
    user: "deploy",
    authMethod: "password",
  },
  connection: {
    transport: "ssh",
    phase: "failed",
    source: "renderer",
    updatedAt: 1,
    reason: "password",
    failedAtPhase: "authenticating",
  },
};

test("SSH failure and disconnect banners announce dynamic status", () => {
  const view = render(<PtyErrorBanner session={remoteSession} error="password authentication failed" />);
  expect(screen.getByRole("alert").textContent).toContain("SSH connection failed");

  view.rerender(<TerminalExitBanner session={remoteSession} exitCode={SSH_DISCONNECTED_EXIT_CODE} />);
  expect(screen.getByRole("alert").textContent).toContain("SSH connection interrupted");

  view.rerender(<TerminalExitBanner session={remoteSession} exitCode={0} />);
  expect(screen.getByRole("status")).toBeTruthy();
});
