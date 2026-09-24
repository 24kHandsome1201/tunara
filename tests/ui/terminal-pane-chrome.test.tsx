import type { Terminal } from "@xterm/xterm";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setLanguage } from "@/modules/i18n";
import { SSH_DISCONNECTED_EXIT_CODE } from "@/modules/terminal/lib/pty-bridge";
import { createTerminalOutputBuffer } from "@/modules/terminal/lib/terminal-output-buffer";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { PtyErrorBanner, RestoredHistoryNotice, TerminalExitBanner } from "@/ui/TerminalExitBanner";
import { handleTerminalProcessExit } from "@/ui/terminal-exit";
import type { Session } from "@/ui/types";

const disconnected: Session = {
  id: "ssh-dead", title: "SSH", dir: "/srv", branch: "", runState: "failed", updatedAt: 1,
  remote: { host: "target.internal", port: 22, user: "deploy", autoReconnect: false },
  ptyId: 7,
  transportGeneration: "generation-7",
  connection: { transport: "ssh", phase: "needsUserAction", source: "transport", updatedAt: 2, reason: "connect" },
};

function renderInPane(node: React.ReactNode) {
  return render(<div data-terminal-session-id={disconnected.id}>{node}</div>);
}

test.each([["en", "Reconnect"], ["zh-CN", "重新连接"]] as const)("a disconnected SSH bar offers exactly one primary Reconnect (%s)", (lang, name) => {
  setLanguage(lang);
  useSessionsStore.setState({ sessions: [disconnected], activeSessionId: disconnected.id });
  useUIStore.setState({ overlay: null, sshPrefill: null });
  renderInPane(<TerminalExitBanner session={disconnected} exitCode={SSH_DISCONNECTED_EXIT_CODE} />);

  const bar = screen.getByRole("alert");
  const reconnects = within(bar).getAllByRole("button", { name });
  expect(reconnects).toHaveLength(1);
  // Pane activation and attention reveal focus the last button in the bar.
  const buttons = bar.querySelectorAll("button");
  expect(buttons[buttons.length - 1]).toBe(reconnects[0]);
  // The remediation still contributes its context, without its own button.
  expect(bar.querySelector("[data-remediation-kind=\"reconnect\"]")).not.toBeNull();

  fireEvent.click(reconnects[0]);
  expect(useUIStore.getState().overlay).toBe("ssh");
  expect(useUIStore.getState().sshPrefill).toMatchObject({ host: "target.internal", reconnectSessionId: disconnected.id });
});

test("a credential remediation replaces the open-error retry instead of adding a second action", () => {
  const needsAuth: Session = { ...disconnected, connection: { ...disconnected.connection!, reason: "auth" } };
  useSessionsStore.setState({ sessions: [needsAuth], activeSessionId: needsAuth.id });
  renderInPane(<PtyErrorBanner session={needsAuth} error="auth failed" />);

  const bar = screen.getByRole("alert");
  expect(within(bar).getAllByRole("button", { name: "Provide credentials" })).toHaveLength(1);
  expect(within(bar).queryByRole("button", { name: "Retry" })).toBeNull();
});

test("status labels truncate on one line with the full text as a tooltip", () => {
  setLanguage("zh-CN");
  const local: Session = { id: "local", title: "Local", dir: "/tmp", branch: "", runState: "idle", updatedAt: 1 };
  useSessionsStore.setState({ sessions: [local], activeSessionId: local.id });
  render(<TerminalExitBanner session={local} exitCode={0} />);

  const label = screen.getByTitle("进程已退出");
  expect(label.style.whiteSpace).toBe("nowrap");
  expect(label.style.textOverflow).toBe("ellipsis");
  for (const button of screen.getByRole("status").querySelectorAll("button")) {
    expect(button.style.whiteSpace).toBe("nowrap");
  }
});

test("the restored-history notice takes layout space instead of covering terminal rows", () => {
  const dismiss = vi.fn();
  render(<RestoredHistoryNotice remote={false} onDismiss={dismiss} />);
  const notice = screen.getByRole("status");
  expect(notice.style.position).not.toBe("absolute");
  expect(notice.style.flexShrink).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(dismiss).toHaveBeenCalledOnce();
});

test("the exit notice is written after output still queued in the frame buffer", async () => {
  const writes: string[] = [];
  const decoder = new TextDecoder();
  const term = {
    options: {} as Terminal["options"],
    write(data: string | Uint8Array, callback?: () => void) {
      writes.push(typeof data === "string" ? data : decoder.decode(data));
      queueMicrotask(() => callback?.());
    },
  } as unknown as Terminal;
  const buffer = createTerminalOutputBuffer(term, {
    requestFrame: (callback) => setTimeout(() => callback(0), 5) as unknown as number,
    cancelFrame: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  });
  useSessionsStore.setState({ sessions: [{ id: "exit-order", title: "", dir: "/", branch: "", runState: "running", updatedAt: 1 }] });

  buffer.push(new TextEncoder().encode("exit\r\n"));
  await handleTerminalProcessExit(term, "exit-order", 0, false, buffer.drain());

  expect(writes[0]).toBe("exit\r\n");
  expect(writes[1]).toContain("[process exited: 0]");
  expect(term.options.disableStdin).toBe(true);
  buffer.dispose();
});

test("the exit notice is skipped when the view was torn down while draining", async () => {
  const write = vi.fn();
  const term = { options: {}, write } as unknown as Terminal;
  useSessionsStore.setState({ sessions: [{ id: "exit-disposed", title: "", dir: "/", branch: "", runState: "running", updatedAt: 1 }] });
  await handleTerminalProcessExit(term, "exit-disposed", 0, false, Promise.resolve(), () => true);
  expect(write).not.toHaveBeenCalled();
});
