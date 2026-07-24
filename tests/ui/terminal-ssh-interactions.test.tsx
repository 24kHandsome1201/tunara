import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { expect, test, vi } from "vitest";
import {
  openSshPty,
  openPty,
  recordPtyExit,
  SSH_DISCONNECTED_EXIT_CODE,
  type PtyEvent,
  type PtyHandlers,
} from "@/modules/terminal/lib/pty-bridge";
import { createTerminalPtyGenerationGate } from "@/modules/terminal/lib/terminal-pty-generation";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { ContextMenu } from "@/ui/ContextMenu";
import { SplitHandle } from "@/ui/SplitHandle";
import { PtyErrorBanner, TerminalExitBanner } from "@/ui/TerminalExitBanner";
import { ToastContainer } from "@/ui/Toast";
import type { Session } from "@/ui/types";

test("local PTY events wait for generation publication before reaching the renderer", async () => {
  let channel: Channel<PtyEvent> | undefined;
  mockIPC((command, payload) => {
    if (command === "pty_open") {
      channel = (payload as { onEvent: Channel<PtyEvent> }).onEvent;
      channel.onmessage({ type: "data", data: "YQ==" });
      channel.onmessage({ type: "exit", code: 0 });
      return 77;
    }
    if (command === "pty_output_ack" || command === "pty_close") return undefined;
    throw new Error(`unexpected command: ${command}`);
  });
  const onData = vi.fn((_bytes: Uint8Array, acknowledge: () => void) => acknowledge());
  const onExit = vi.fn();
  const pty = await openPty("local-generation", 80, 24, { onData, onExit });

  expect(onData).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
  expect(pty.activate()).toBe(true);
  expect(onData).toHaveBeenCalledOnce();
  expect(onExit).toHaveBeenCalledWith(0, pty.generation);
  expect(pty.activate()).toBe(false);
});

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
    onPendingConnectionStatus: vi.fn(),
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

  expect(newerHandlers.onConnectionStatus).not.toHaveBeenCalled();
  expect(newerHandlers.onPendingConnectionStatus).toHaveBeenCalledWith("ready");
  expect(olderHandlers.onConnectionStatus).not.toHaveBeenCalled();
  expect(useUIStore.getState().hostKeyPrompts).toEqual([]);

  resolveOpen[1](202);
  const newer = await newerOpen;
  expect(newer.activate()).toBe(true);
  expect(newerHandlers.onConnectionStatus).toHaveBeenCalledWith("ready", newer.generation);
  resolveOpen[0](101);
  const older = await olderOpen;
  expect(older.activate()).toBe(false);
  await older.close();
  expect(closed).toEqual([101]);

  // Closing the stale physical connection must not clear the newer logical
  // generation; its live Channel still owns status events.
  channels[1].onmessage({ type: "connectionStatus", phase: "openingShell" });
  expect(newerHandlers.onConnectionStatus).toHaveBeenLastCalledWith("openingShell", newer.generation);

  await newer.close();
  channels[1].onmessage({ type: "exit", code: SSH_DISCONNECTED_EXIT_CODE });
  expect(newerHandlers.onExit).not.toHaveBeenCalled();
  expect(closed).toEqual([101, 202]);
});

test("store-level generation checks reject old exit events during a reconnect remount", () => {
  const session: Session = {
    id: "store-generation",
    title: "deploy@example",
    dir: "/srv/app",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    remote: { host: "example", port: 22, user: "deploy", authMethod: "agent" },
    transportGeneration: "ssh:old",
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  };
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  useSessionsStore.getState().updateSession(session.id, {
    transportGeneration: undefined,
    connection: { transport: "ssh", phase: "reconnecting", source: "user", updatedAt: 2 },
  });

  recordPtyExit(session.id, true, SSH_DISCONNECTED_EXIT_CODE, "ssh:old");
  expect(useSessionsStore.getState().sessions[0].connection?.phase).toBe("reconnecting");
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
  const publishedPty = await published;
  expect(publishedPty.activate()).toBe(true);

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

test("generation gate prioritizes transport loss and acknowledges every stale data event", () => {
  const onData = vi.fn((_bytes: Uint8Array, acknowledge: () => void) => acknowledge());
  const onTransportLost = vi.fn();
  const onExit = vi.fn();
  const onConnectionStatus = vi.fn();
  const gate = createTerminalPtyGenerationGate({ onData, onTransportLost, onExit, onConnectionStatus });
  const staleAck = vi.fn();

  gate.publish("ssh:one");
  gate.handlers.onData(new Uint8Array([1]), vi.fn(), "ssh:one");
  gate.publish("ssh:two");
  gate.handlers.onData(new Uint8Array([2]), staleAck, "ssh:one");
  gate.handlers.onConnectionStatus?.("ready", "ssh:one");
  gate.handlers.onTransportLost?.("transportClosed", "ssh:one");
  gate.handlers.onExit?.(-2, "ssh:one");

  expect(staleAck).toHaveBeenCalledOnce();
  expect(onData).toHaveBeenCalledOnce();
  expect(onConnectionStatus).not.toHaveBeenCalled();
  expect(onTransportLost).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();

  gate.handlers.onTransportLost?.("transportClosed", "ssh:two");
  gate.handlers.onExit?.(-2, "ssh:two");
  const terminatedAck = vi.fn();
  gate.handlers.onData(new Uint8Array([3]), terminatedAck, "ssh:two");
  expect(onTransportLost).toHaveBeenCalledOnce();
  expect(onExit).not.toHaveBeenCalled();
  expect(terminatedAck).toHaveBeenCalledOnce();
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

test("a background terminal failure does not steal focus from another control", () => {
  const activeControl = document.createElement("button");
  document.body.appendChild(activeControl);
  activeControl.focus();

  render(
    <div data-terminal-session-id={remoteSession.id}>
      <PtyErrorBanner session={remoteSession} error="password authentication failed" />
    </div>,
  );

  expect(document.activeElement).toBe(activeControl);
  activeControl.remove();
});

test("a dead terminal moves its own textarea focus to the primary recovery action", () => {
  const pane = document.createElement("div");
  pane.dataset.terminalSessionId = remoteSession.id;
  const terminalInput = document.createElement("textarea");
  const bannerRoot = document.createElement("div");
  pane.append(terminalInput, bannerRoot);
  document.body.appendChild(pane);
  terminalInput.focus();

  const view = render(
    <PtyErrorBanner session={remoteSession} error="password authentication failed" />,
    { container: bannerRoot },
  );

  expect(document.activeElement).toBe(view.getByRole("button", { name: "Retry" }));
  view.unmount();
  pane.remove();
});

test("toast countdown stays paused while hover and keyboard focus overlap", () => {
  useUIStore.setState({ toasts: [] });
  useUIStore.getState().addToast({ title: "Paused toast", subtitle: "", variant: "success" });
  render(<ToastContainer />);
  const toast = screen.getByRole("status");
  const close = screen.getByRole("button", { name: "Close" });
  const progress = [...toast.querySelectorAll<HTMLElement>("div")]
    .find((element) => element.style.animation.includes("toastProgress"));

  fireEvent.mouseEnter(toast);
  close.focus();
  fireEvent.mouseLeave(toast);
  expect(progress?.style.animationPlayState).toBe("paused");

  fireEvent.blur(close);
  expect(progress?.style.animationPlayState).toBe("running");
});
