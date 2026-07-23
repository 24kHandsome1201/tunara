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
} from "@/modules/terminal/lib/pty-bridge";
import { useUIStore } from "@/state/ui";
import { ContextMenu } from "@/ui/ContextMenu";
import { SplitHandle } from "@/ui/SplitHandle";
import { PtyErrorBanner, TerminalExitBanner } from "@/ui/TerminalExitBanner";
import type { Session } from "@/ui/types";

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
