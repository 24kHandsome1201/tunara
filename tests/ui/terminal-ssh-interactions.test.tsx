import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { TerminalQuickSelect } from "@/ui/TerminalQuickSelect";
import { TerminalViewChrome } from "@/ui/TerminalViewChrome";
import { ToastContainer } from "@/ui/Toast";
import { SessionCard } from "@/ui/SessionCard";
import { buildSessionMenuItems } from "@/ui/sidebar-session-menu";
import { HostKeyPromptDialog } from "@/ui/overlays/HostKeyPrompt";
import { KeyboardInteractivePromptDialog } from "@/ui/overlays/KeyboardInteractivePrompt";
import { WorkflowParamPrompt } from "@/ui/overlays/WorkflowParamPrompt";
import { useTerminalQuickSelect } from "@/ui/useTerminalQuickSelect";
import { TERMINAL_QUICK_SELECT_EVENT } from "@/modules/terminal/lib/terminal-quick-select";
import { useTerminalSearch } from "@/ui/useTerminalSearch";
import {
  allocateTerminalInstanceEpoch,
  recordTerminalFocusIntent,
  registerTerminalBinding,
} from "@/modules/terminal/lib/binding-aware-async-action";
import type { Session } from "@/ui/types";
import type { Terminal } from "@xterm/xterm";

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

test("ProxyJump v2 keeps hop credentials independent and accepts only backend binding generation", async () => {
  let request: Record<string, unknown> | undefined;
  mockIPC((command, payload) => {
    if (command === "ssh_open_v2") {
      request = (payload as { request: Record<string, unknown> }).request;
      return {
        physicalPtyId: 88,
        transportGeneration: "tg-route",
        warnings: [],
        binding: {
          logicalSessionId: "route-session",
          physicalPtyId: 88,
          transportGeneration: "tg-route",
        },
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });

  const pty = await openSshPty("route-session", 80, 24, { onData: vi.fn() }, {
    host: "target.internal",
    user: "target-user",
    authMethod: "key",
    identityFile: "/keys/target",
    certificateFile: "/keys/target-cert.pub",
    password: "must-not-cross-target-method",
    jump: {
      host: "jump.example",
      user: "jump-user",
      authMethod: "password",
      password: "jump-one-shot",
      identityFile: "/keys/must-not-cross-jump-method",
      certificateFile: "/keys/must-not-cross-jump-method-cert.pub",
    },
  });

  expect(pty.generation).toBe("tg-route");
  expect(request).toMatchObject({
    endpoint: {
      host: "target.internal",
      authMethod: "key",
      identityFile: "/keys/target",
      certificateFile: "/keys/target-cert.pub",
      password: null,
    },
    jump: {
      host: "jump.example",
      authMethod: "password",
      identityFile: null,
      certificateFile: null,
      password: "jump-one-shot",
    },
  });
});

test("ProxyJump prompts are labeled from the ordered jump and target handshake phases", async () => {
  let channel: Channel<PtyEvent> | undefined;
  let openAttemptId = "";
  let resolveOpen!: (result: {
    physicalPtyId: number;
    transportGeneration: string;
    warnings: string[];
    binding: { logicalSessionId: string; physicalPtyId: number; transportGeneration: string };
  }) => void;
  mockIPC((command, payload) => {
    if (command === "ssh_open_v2") {
      channel = (payload as { onEvent: Channel<PtyEvent> }).onEvent;
      openAttemptId = (payload as { request: { openAttemptId: string } }).request.openAttemptId;
      return new Promise((resolve) => { resolveOpen = resolve; });
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ hostKeyPrompts: [], keyboardInteractivePrompts: [] });

  const opening = openSshPty("hop-prompts", 80, 24, { onData: vi.fn() }, {
    host: "target.internal",
    user: "target",
    authMethod: "keyboard-interactive",
    jump: { host: "jump.example", user: "jump", authMethod: "agent" },
  });
  channel!.onmessage({ type: "connectionStatus", phase: "handshaking" });
  channel!.onmessage({ type: "hostKeyPrompt", promptId: "jump-key", host: "jump.example", port: 22, fingerprint: "SHA256:jump", keyType: "ssh-ed25519", reason: "unknown" });
  expect(useUIStore.getState().hostKeyPrompts[0]?.hopRole).toBe("jump");

  channel!.onmessage({ type: "connectionStatus", phase: "handshaking" });
  channel!.onmessage({
    type: "keyboardInteractivePrompt",
    promptId: "target-auth",
    origin: { user: "target", host: "target.internal", port: 22, logicalSessionId: "hop-prompts", hopRole: "target", transportGeneration: openAttemptId },
    name: "Target auth",
    instructions: "",
    prompts: [{ prompt: "Code", echo: false }],
  });
  expect(useUIStore.getState().keyboardInteractivePrompts[0]?.hopRole).toBe("target");

  resolveOpen({
    physicalPtyId: 89,
    transportGeneration: "tg-hop-prompts",
    warnings: [],
    binding: { logicalSessionId: "hop-prompts", physicalPtyId: 89, transportGeneration: "tg-hop-prompts" },
  });
  await opening;
  useUIStore.setState({ hostKeyPrompts: [], keyboardInteractivePrompts: [] });
});

test("superseded SSH channels cannot mutate the new connection generation", async () => {
  const channels: Array<Channel<PtyEvent>> = [];
  const openAttemptIds: string[] = [];
  const keyboardResponses: unknown[] = [];
  const resolveOpen: Array<(result: {
    physicalPtyId: number;
    transportGeneration: string;
    warnings: string[];
    binding: { logicalSessionId: string; physicalPtyId: number; transportGeneration: string };
  }) => void> = [];
  const closed: number[] = [];
  mockIPC((command, payload) => {
    if (command === "ssh_open_v2") {
      channels.push((payload as { onEvent: Channel<PtyEvent> }).onEvent);
      openAttemptIds.push((payload as { request: { openAttemptId: string } }).request.openAttemptId);
      return new Promise((resolve) => resolveOpen.push(resolve));
    }
    if (command === "ssh_keyboard_interactive_response") {
      keyboardResponses.push(payload);
      return undefined;
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
  channels[0].onmessage({
    type: "keyboardInteractivePrompt",
    promptId: "stale-kbi",
    origin: {
      user: "deploy", host: "ssh.example", port: 22, logicalSessionId: "generation-session",
      hopRole: "direct", transportGeneration: openAttemptIds[0],
    },
    name: "Stale server name",
    instructions: "Stale instructions",
    prompts: [{ prompt: "Password", echo: false }],
  });

  expect(newerHandlers.onConnectionStatus).not.toHaveBeenCalled();
  expect(newerHandlers.onPendingConnectionStatus).toHaveBeenCalledWith("ready");
  expect(olderHandlers.onConnectionStatus).not.toHaveBeenCalled();
  expect(useUIStore.getState().hostKeyPrompts).toEqual([]);
  expect(useUIStore.getState().keyboardInteractivePrompts).toEqual([]);
  expect(keyboardResponses).toContainEqual({ promptId: "stale-kbi", responses: null });

  resolveOpen[1]({
    physicalPtyId: 202,
    transportGeneration: "tg-new",
    warnings: [],
    binding: { logicalSessionId: "generation-session", physicalPtyId: 202, transportGeneration: "tg-new" },
  });
  const newer = await newerOpen;
  expect(newer.activate()).toBe(true);
  expect(newerHandlers.onConnectionStatus).toHaveBeenCalledWith("ready", newer.generation);
  resolveOpen[0]({
    physicalPtyId: 101,
    transportGeneration: "tg-old",
    warnings: [],
    binding: { logicalSessionId: "generation-session", physicalPtyId: 101, transportGeneration: "tg-old" },
  });
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
  const opens: Array<{
    resolve: (result: {
      physicalPtyId: number;
      transportGeneration: string;
      warnings: string[];
      binding: { logicalSessionId: string; physicalPtyId: number; transportGeneration: string };
    }) => void;
    reject: (error: unknown) => void;
  }> = [];
  const acknowledgements: Array<{ id: number; bytes: number }> = [];
  mockIPC((command, payload) => {
    if (command === "ssh_open_v2") {
      channels.push((payload as { onEvent: Channel<PtyEvent> }).onEvent);
      return new Promise((resolve, reject) => opens.push({ resolve, reject }));
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
  opens[0].resolve({
    physicalPtyId: 301,
    transportGeneration: "tg-published",
    warnings: [],
    binding: {
      logicalSessionId: "failed-replacement-session",
      physicalPtyId: 301,
      transportGeneration: "tg-published",
    },
  });
  const publishedPty = await published;
  expect(publishedPty.activate()).toBe(true);

  const failedReplacement = openSshPty("failed-replacement-session", 80, 24, {
    onData: vi.fn(),
  }, { host: "new.example", user: "deploy", authMethod: "agent" });
  channels[0].onmessage({ type: "data", data: "YQ==" });
  await Promise.resolve();
  expect(publishedData).toHaveBeenCalledOnce();
  expect(acknowledgements).toEqual([{ id: 301, bytes: 1 }]);

  opens[1].reject({
    diagnostic: {
      schemaVersion: 1,
      stage: "jump",
      code: "authenticationFailed",
      severity: "error",
      retryable: false,
      hopRole: "jump",
      timestamp: 1,
    },
  });
  await expect(failedReplacement).rejects.toThrow("SSH jump hop authentication failed");
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

function TerminalViewChromeHarness({ mouseTrackingMode }: { mouseTrackingMode: "none" | "any" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const search = useTerminalSearch("router-session");
  const terminal = {
    modes: { mouseTrackingMode },
    hasSelection: () => false,
    getSelection: () => "",
  } as unknown as Terminal;
  return (
    <TerminalViewChrome
      sessionId="router-session"
      containerRef={containerRef}
      getTerminal={() => terminal}
      search={search}
      capturePasteTarget={() => () => true}
    />
  );
}

function dispatchTerminalMouse(
  surface: HTMLElement,
  type: "mousedown" | "mouseup" | "contextmenu",
  modifiers: MouseEventInit = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 2,
    ...modifiers,
  });
  act(() => { surface.dispatchEvent(event); });
  return event;
}

test.each([
  ["down → up → contextmenu", ["mousedown", "mouseup", "contextmenu"]],
  ["down → contextmenu → up", ["mousedown", "contextmenu", "mouseup"]],
] as const)("TerminalViewChrome suppresses the native menu without consuming a TUI-owned %s gesture", (_label, order) => {
  useUIStore.setState({ terminalHostModifier: "shift", presentationMode: "workspace" });
  render(<TerminalViewChromeHarness mouseTrackingMode="any" />);
  const surface = document.querySelector<HTMLElement>("[data-terminal-canvas]")!;
  const onMouseDown = vi.fn();
  const onMouseUp = vi.fn();
  surface.addEventListener("mousedown", onMouseDown);
  surface.addEventListener("mouseup", onMouseUp);

  let contextMenu: MouseEvent | undefined;
  const events = order.map((type) => {
    const event = dispatchTerminalMouse(surface, type);
    if (type === "contextmenu") contextMenu = event;
    return event;
  });

  expect(contextMenu?.defaultPrevented).toBe(true);
  expect(events.filter((event) => event.type === "mousedown" || event.type === "mouseup")
    .every((event) => !event.defaultPrevented)).toBe(true);
  expect(onMouseDown).toHaveBeenCalledOnce();
  expect(onMouseUp).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("TerminalViewChrome opens the Tunara menu when reporting is off or the host modifier is held", () => {
  useUIStore.setState({ terminalHostModifier: "shift", presentationMode: "workspace" });
  const view = render(<TerminalViewChromeHarness mouseTrackingMode="none" />);
  let surface = document.querySelector<HTMLElement>("[data-terminal-canvas]")!;

  dispatchTerminalMouse(surface, "mousedown");
  dispatchTerminalMouse(surface, "mouseup");
  expect(dispatchTerminalMouse(surface, "contextmenu").defaultPrevented).toBe(true);
  expect(screen.getByRole("menu")).toBeTruthy();

  view.unmount();
  render(<TerminalViewChromeHarness mouseTrackingMode="any" />);
  surface = document.querySelector<HTMLElement>("[data-terminal-canvas]")!;
  dispatchTerminalMouse(surface, "mousedown", { shiftKey: true });
  dispatchTerminalMouse(surface, "mouseup", { shiftKey: true });
  expect(dispatchTerminalMouse(surface, "contextmenu", { shiftKey: true }).defaultPrevented).toBe(true);
  expect(screen.getByRole("menu")).toBeTruthy();
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

test("token-aware context menu restores only the still-active terminal", async () => {
  const focus = vi.fn();
  const dispose = registerTerminalBinding({
    logicalSessionId: "menu-session",
    paneId: "menu-session",
    physicalPtyId: 17,
    transportGeneration: "menu-generation",
    terminalInstanceEpoch: allocateTerminalInstanceEpoch(),
  }, focus);
  recordTerminalFocusIntent("menu-session");
  const { issueFocusReturnToken } = await import("@/modules/terminal/lib/binding-aware-async-action");
  const view = render(
    <ContextMenu
      items={[{ id: "copy", label: "Copy", action: vi.fn() }]}
      position={{ x: 12, y: 12 }}
      onClose={() => {}}
      terminalFocusReturnToken={issueFocusReturnToken("menu-session")}
    />,
  );

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menu")));
  view.unmount();
  expect(focus).toHaveBeenCalledOnce();
  dispose();
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

test("Quick Select exposes listbox selection and target-specific action names", () => {
  const onCopy = vi.fn();
  const onOpen = vi.fn();
  render(<TerminalQuickSelect
    items={[
      { id: "url:docs example", kind: "url", label: "docs.example", detail: "https://docs.example", copyText: "https://docs.example", target: "https://docs.example" },
      { id: "file-two", kind: "file", label: "src/app.ts:12", detail: "/repo/src/app.ts", copyText: "/repo/src/app.ts:12", target: "/repo/src/app.ts", line: 12 },
    ]}
    onClose={() => {}}
    onCopy={onCopy}
    onOpen={onOpen}
  />);

  const listbox = screen.getByRole("listbox", { name: "Quick select" });
  expect(document.activeElement).toBe(listbox);
  expect(listbox.getAttribute("aria-activedescendant")).toBe("quick-select-option-0");
  const options = screen.getAllByRole("option");
  expect(options[0].getAttribute("aria-selected")).toBe("true");
  expect(options[1].getAttribute("aria-selected")).toBe("false");
  expect(screen.getByRole("button", { name: "Copy docs.example" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open src/app.ts:12" })).toBeNull();
  expect(options[0].querySelector("button")).toBeNull();

  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  expect(listbox.getAttribute("aria-activedescendant")).toBe("quick-select-option-1");
  expect(options[1].getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "Copy src/app.ts:12" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open src/app.ts:12" })).toBeTruthy();
});

test("Quick Select restores terminal focus after an asynchronous copy", async () => {
  const focus = vi.fn();
  const term = {
    rows: 24,
    focus,
    buffer: {
      active: {
        length: 1,
        viewportY: 0,
        getLine: () => ({ translateToString: () => "https://docs.example" }),
      },
    },
  } as unknown as Terminal;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  const dispose = registerTerminalBinding({
    logicalSessionId: "quick-select-session",
    paneId: "quick-select-session",
    physicalPtyId: 21,
    transportGeneration: "quick-select-generation",
    terminalInstanceEpoch: allocateTerminalInstanceEpoch(),
  }, focus);
  recordTerminalFocusIntent("quick-select-session");

  function Harness() {
    const termRef = useRef<Terminal | null>(term);
    return useTerminalQuickSelect(termRef, {
      active: true,
      cwd: "/repo",
      sessionId: "quick-select-session",
    }).quickSelectOverlay;
  }

  render(<Harness />);
  window.dispatchEvent(new Event(TERMINAL_QUICK_SELECT_EVENT));
  fireEvent.click(await screen.findByRole("button", { name: "Copy https://docs.example" }));
  await waitFor(() => expect(focus).toHaveBeenCalledOnce());
  expect(screen.queryByRole("listbox", { name: "Quick select" })).toBeNull();
  dispose();
});

test("Quick Select ignores a deferred copy completion after switching sessions", async () => {
  let resolveCopy!: () => void;
  const focus = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; })) },
  });
  const term = {
    rows: 24,
    focus,
    buffer: { active: { length: 1, viewportY: 0, getLine: () => ({ translateToString: () => "https://docs.example" }) } },
  } as unknown as Terminal;
  const dispose = registerTerminalBinding({
    logicalSessionId: "quick-select-stale",
    paneId: "quick-select-stale",
    physicalPtyId: 22,
    transportGeneration: "quick-select-stale-generation",
    terminalInstanceEpoch: allocateTerminalInstanceEpoch(),
  }, focus);
  recordTerminalFocusIntent("quick-select-stale");

  function Harness() {
    const termRef = useRef<Terminal | null>(term);
    return useTerminalQuickSelect(termRef, { active: true, cwd: "/repo", sessionId: "quick-select-stale" }).quickSelectOverlay;
  }

  render(<Harness />);
  window.dispatchEvent(new Event(TERMINAL_QUICK_SELECT_EVENT));
  fireEvent.click(await screen.findByRole("button", { name: "Copy https://docs.example" }));
  recordTerminalFocusIntent("another-session");
  await act(async () => { resolveCopy(); });
  expect(focus).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox", { name: "Quick select" })).toBeTruthy();
  dispose();
});

test("Quick Select opens an SSH file in its owning session instead of the local editor", async () => {
  const owner: Session = {
    id: "quick-select-ssh", title: "SSH", dir: "/srv/app", branch: "", runState: "idle", updatedAt: 1,
    remote: { host: "target.internal", port: 22, user: "deploy" },
    ptyId: 77,
    transportGeneration: "quick-select-generation",
  };
  useSessionsStore.setState({ sessions: [owner, { ...owner, id: "other-session", remote: undefined }], activeSessionId: "other-session" });
  useUIStore.setState({ fileTabs: [], activeFileTabId: null });
  const openedCommands: string[] = [];
  mockIPC((command) => { openedCommands.push(command); return undefined; });
  const term = {
    rows: 24,
    focus: vi.fn(),
    buffer: {
      active: {
        length: 1,
        viewportY: 0,
        getLine: () => ({ translateToString: () => "src/app.ts:12" }),
      },
    },
  } as unknown as Terminal;

  function Harness() {
    const termRef = useRef<Terminal | null>(term);
    return useTerminalQuickSelect(termRef, { active: true, cwd: "/srv/app", sessionId: owner.id }).quickSelectOverlay;
  }

  render(<Harness />);
  window.dispatchEvent(new Event(TERMINAL_QUICK_SELECT_EVENT));
  fireEvent.click(await screen.findByRole("button", { name: "Open src/app.ts:12" }));
  await waitFor(() => expect(useSessionsStore.getState().activeSessionId).toBe(owner.id));
  expect(useUIStore.getState().fileTabs[0]).toMatchObject({ sessionId: owner.id, filePath: "/srv/app/src/app.ts", line: 12 });
  expect(openedCommands).not.toContain("open_in_editor");
});

test("session cards announce lifecycle, unread, and transport state", () => {
  render(<SessionCard
    session={{
      id: "accessible-session",
      title: "Deploy",
      dir: "/srv/app",
      branch: "main",
      runState: "failed",
      unread: true,
      updatedAt: 1,
      remote: { host: "ssh.example", port: 22, user: "deploy" },
    }}
    active
    onSelect={() => {}}
  />);

  expect(screen.getByRole("button", { name: /Deploy, Failed, Unread, Remote SSH session/ })).toBeTruthy();
});

test("session menu exposes bounded keyboard reorder actions", () => {
  const sessions: Session[] = [
    { id: "one", title: "One", dir: "/repo", branch: "main", runState: "idle", updatedAt: 1 },
    { id: "two", title: "Two", dir: "/repo", branch: "main", runState: "idle", updatedAt: 2 },
    { id: "other", title: "Other", dir: "/other", branch: "main", runState: "idle", updatedAt: 3 },
  ];
  useSessionsStore.setState({ sessions });
  const moved: number[] = [];
  const items = buildSessionMenuItems({
    session: sessions[0],
    groupSessions: sessions.slice(0, 2),
    canReorder: true,
    onReordered: (position) => moved.push(position),
    t: (key) => key,
    externalEditor: "vscode",
    onSelectSession: () => {},
  });
  const up = items.find((item) => item?.id === "session:move-up");
  const down = items.find((item) => item?.id === "session:move-down");
  expect(up && up.disabled).toBe(true);
  expect(down && down.disabled).toBe(false);

  down?.action();

  expect(useSessionsStore.getState().sessions.map((session) => session.id)).toEqual(["two", "one", "other"]);
  expect(moved).toEqual([2]);
});

test("workflow parameters keep a scrollable body and reachable footer", () => {
  useUIStore.setState({
    pendingWorkflow: {
      workflowId: "many-params",
      name: "Deploy workflow",
      template: "deploy {{one}} {{two}} {{three}} {{four}} {{five}}",
      dir: "/repo",
    },
  });
  render(<WorkflowParamPrompt />);

  const dialog = screen.getByRole("dialog", { name: "Deploy workflow" });
  expect(dialog.style.maxHeight).toBe("calc(100vh - 32px)");
  const scrollBody = screen.getByLabelText("one").parentElement?.parentElement as HTMLElement;
  expect(scrollBody.style.overflowY).toBe("auto");
  expect(screen.getByRole("button", { name: "Run" }).parentElement?.style.borderTop).toContain("var(--c-border-2)");
  useUIStore.setState({ pendingWorkflow: null });
});

test("host key prompt constrains height and safely focuses Reject", () => {
  useUIStore.setState({
    hostKeyPrompts: [{
      hopRole: "direct",
      promptId: "host-key-overflow",
      host: "very-long-host.example",
      port: 22,
      fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz",
      keyType: "ssh-ed25519",
      reason: "unknown",
    }],
  });
  render(<HostKeyPromptDialog />);

  const dialog = screen.getByRole("dialog", { name: "Verify host key" });
  expect(dialog.style.maxHeight).toBe("calc(100vh - 32px)");
  expect(screen.getByRole("button", { name: "Cancel" })).toBe(document.activeElement);
  const body = screen.getByText(/very-long-host\.example/).parentElement as HTMLElement;
  expect(body.style.overflowY).toBe("auto");
  useUIStore.setState({ hostKeyPrompts: [] });
});

test("keyboard-interactive trust chrome is Tunara-owned and server text stays in the body", () => {
  useUIStore.setState({
    keyboardInteractivePrompts: [{
      hopRole: "jump",
      promptId: "trusted-origin",
      origin: {
        user: "ops", host: "jump.internal", port: 2202, logicalSessionId: "session-kbi",
        hopRole: "jump", transportGeneration: "attempt-kbi",
      },
      name: "SERVER CONTROLLED TITLE",
      instructions: "SERVER CONTROLLED INSTRUCTIONS",
      prompts: [{ prompt: "SERVER CONTROLLED LABEL", echo: false }],
    }],
  });
  render(<KeyboardInteractivePromptDialog />);

  expect(screen.getByRole("dialog", { name: "Authentication required" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "SERVER CONTROLLED TITLE" })).toBeNull();
  expect(screen.getByText(/ops@jump\.internal:2202/)).toBeTruthy();
  expect(screen.getByText("SERVER CONTROLLED TITLE")).toBeTruthy();
  expect(screen.getByText("SERVER CONTROLLED INSTRUCTIONS")).toBeTruthy();
  expect(screen.getByLabelText("SERVER CONTROLLED LABEL")).toBeTruthy();
  useUIStore.setState({ keyboardInteractivePrompts: [] });
});

test.each([
  ["host key", <HostKeyPromptDialog />, () => useUIStore.getState().enqueueHostKeyPrompt({
    hopRole: "direct", promptId: "late-host", host: "late.example", port: 22,
    fingerprint: "SHA256:late", keyType: "ssh-ed25519", reason: "unknown",
  }), "Cancel", "Trust & connect", "ssh_host_key_decision"],
  ["keyboard interactive", <KeyboardInteractivePromptDialog />, () => useUIStore.getState().enqueueKeyboardInteractivePrompt({
    hopRole: "direct", promptId: "late-auth", name: "Late auth", instructions: "",
    origin: { user: "deploy", host: "late.example", port: 22, logicalSessionId: "late-session", hopRole: "direct", transportGeneration: "late-generation" },
    prompts: [{ prompt: "Password", echo: false }],
  }), "Password", "Continue", "ssh_keyboard_interactive_response"],
] as const)("a permanently mounted %s prompt traps focus and safely cancels", async (_name, dialog, enqueue, safeName, lastName, commandName) => {
  useUIStore.setState({ hostKeyPrompts: [], keyboardInteractivePrompts: [] });
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return undefined;
  });
  render(<><button type="button">Outside</button>{dialog}</>);
  const outside = screen.getByRole("button", { name: "Outside" });
  outside.focus();

  act(enqueue);
  const safe = safeName === "Password"
    ? await screen.findByLabelText(safeName)
    : await screen.findByRole("button", { name: safeName });
  await waitFor(() => expect(document.activeElement).toBe(safe));
  const last = screen.getByRole("button", { name: lastName });
  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(safe);
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((call) => call.command === commandName)?.payload).toMatchObject(
    commandName === "ssh_host_key_decision" ? { accept: false } : { responses: null },
  );
  expect(document.activeElement).toBe(outside);
});
