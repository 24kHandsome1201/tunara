import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { AttentionRow } from "@/ui/AttentionRow";
import { ReaderPane } from "@/ui/ReaderPane";
import { RestoredHistoryNotice } from "@/ui/TerminalExitBanner";
import { useTerminalBlocks } from "@/ui/useTerminalBlocks";
import { useTerminalRuntimeSync } from "@/ui/useTerminalRuntimeSync";
import { registerTerminalActions, revealSessionAttention } from "@/modules/terminal/lib/terminal-action-registry";
import type { Session } from "@/ui/types";

vi.mock("@/ui/FilePreview", () => ({ FilePreview: () => <input aria-label="Find in file" /> }));
const session: Session = { id: "ux-session", title: "Terminal 1", dir: "/project", branch: "main", runState: "failed", unread: true, updatedAt: 1 };

test("attention exposes a reason, focuses its terminal and never acts on an inactive registration", () => {
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  const focus = vi.fn();
  const reveal = vi.fn();
  const unregister = registerTerminalActions(session.id, { terminal: { focus } as unknown as Terminal, openSearch: vi.fn(), revealAttention: reveal });
  render(<AttentionRow sessions={[session]} onSelectSession={(id) => useSessionsStore.getState().setActive(id)} />);
  const button = screen.getByRole("button", { name: "Needs you · 1" });
  expect(button.getAttribute("aria-description")).toBe("Command failed");
  fireEvent.click(button);
  expect(focus).toHaveBeenCalledOnce();
  expect(reveal).toHaveBeenCalledOnce();
  expect(useUIStore.getState().focusedPaneId).toBe(session.id);
  useSessionsStore.setState({ activeSessionId: "other" });
  revealSessionAttention(session.id);
  expect(focus).toHaveBeenCalledOnce();
  unregister();
});

test("failed command reveal follows live markers, not guessed or discarded rows", () => {
  const markers: Array<{ line: number; isDisposed: boolean; dispose: () => void }> = [];
  const scrollToLine = vi.fn();
  const buffer = { type: "normal", length: 100, cursorY: 0, baseY: 0 };
  const terminal = { buffer: { active: buffer }, scrollToLine, registerMarker: (line: number) => {
    const marker = { line, isDisposed: false, dispose() { this.isDisposed = true; } }; markers.push(marker); return marker;
  } } as unknown as Terminal;
  const { result } = renderHook(() => useTerminalBlocks({ current: terminal }));
  act(() => result.current.beginBlock("pnpm test", 10));
  act(() => result.current.finishBlock(1, 20));
  markers[0].line = 6;
  result.current.revealFailedCommand("pnpm test", 1);
  expect(scrollToLine).toHaveBeenCalledWith(6);
  scrollToLine.mockClear();
  result.current.revealFailedCommand("other command", 1);
  buffer.type = "alternate";
  result.current.revealFailedCommand("pnpm test", 1);
  buffer.type = "normal";
  markers[0].isDisposed = true;
  result.current.revealFailedCommand("pnpm test", 1);
  expect(scrollToLine).not.toHaveBeenCalled();
});

test("disconnected attention focuses recovery without activating it", () => {
  useSessionsStore.setState({ sessions: [{ ...session, connection: { phase: "disconnected", transport: "ssh", source: "backend", updatedAt: 2 } }], activeSessionId: session.id });
  const reconnect = vi.fn();
  render(<div data-terminal-session-id={session.id}><div role="alert"><button>Details</button><button onClick={reconnect}>Reconnect</button></div></div>);
  revealSessionAttention(session.id);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reconnect" }));
  expect(reconnect).not.toHaveBeenCalled();
});

test("activating a previously hidden dead terminal focuses recovery after layout", async () => {
  render(<div data-terminal-session-id={session.id}><div data-testid="xterm" /><div role="alert"><button>Reconnect</button></div></div>);
  const focus = vi.fn();
  const termRef = { current: { element: screen.getByTestId("xterm"), options: {}, rows: 0, cols: 80, focus } as unknown as Terminal };
  const fitRef = { current: { fit: vi.fn() } as unknown as FitAddon };
  const ptyRef = { current: null };
  const view = renderHook(({ active }) => useTerminalRuntimeSync({ sessionId: session.id, active, termReady: true, termRef, fitRef, ptyRef, fontSize: 14, fontFamily: "monospace", nerdFontFallback: false, scrollback: 1000, cursorStyle: "bar", cursorBlink: true, screenReaderMode: false, theme: "light", accent: "#c2683c" }), { initialProps: { active: false } });
  view.rerender({ active: true });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reconnect" })));
  expect(focus).not.toHaveBeenCalled();
});

test("a terminal that becomes ready does not steal focus from typing elsewhere", async () => {
  render(<><input aria-label="Rename" /><div data-terminal-session-id={session.id}><div data-testid="xterm" className="xterm"><textarea aria-label="Other pane" /></div></div></>);
  const focus = vi.fn();
  const termRef = { current: { element: screen.getByTestId("xterm"), options: {}, rows: 0, cols: 80, focus } as unknown as Terminal };
  const fitRef = { current: { fit: vi.fn() } as unknown as FitAddon };
  const ptyRef = { current: null };
  const rename = screen.getByRole("textbox", { name: "Rename" });
  rename.focus();
  const view = renderHook(({ termReady }) => useTerminalRuntimeSync({ sessionId: session.id, active: true, termReady, termRef, fitRef, ptyRef, fontSize: 14, fontFamily: "monospace", nerdFontFallback: false, scrollback: 1000, cursorStyle: "bar", cursorBlink: true, screenReaderMode: false, theme: "light", accent: "#c2683c" }), { initialProps: { termReady: false } });
  view.rerender({ termReady: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(rename);
  screen.getByRole("textbox", { name: "Other pane" }).focus();
  view.rerender({ termReady: false });
  view.rerender({ termReady: true });
  await waitFor(() => expect(focus).toHaveBeenCalledOnce());
});

test("reader takes focus, returns without closing, and close does not bubble into reader selection", async () => {
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
  useUIStore.getState().openReader({ sessionId: session.id, filePath: "/project/a.ts", fileName: "a.ts" });
  const focus = vi.fn();
  const unregister = registerTerminalActions(session.id, { terminal: { focus } as unknown as Terminal, openSearch: vi.fn() });
  const parentClick = vi.fn();
  render(<div onClick={parentClick}><ReaderPane session={session} active /></div>);
  const root = document.querySelector<HTMLElement>("[data-reader-session-id]")!;
  await waitFor(() => expect(document.activeElement).toBe(root));
  const find = await screen.findByRole("textbox", { name: "Find in file" });
  fireEvent.keyDown(find, { key: "Escape" });
  expect(focus).not.toHaveBeenCalled();
  fireEvent.keyDown(root, { key: "Escape" });
  expect(focus).toHaveBeenCalledOnce();
  expect(useUIStore.getState().readers[session.id].current).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Return to terminal" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(parentClick).not.toHaveBeenCalled();
  expect(useUIStore.getState().focusedPaneId).toBe(session.id);
  unregister();
});

test("restored output is explicitly distinct from the current process and dismissible", () => {
  const dismiss = vi.fn();
  const view = render(<RestoredHistoryNotice remote={false} onDismiss={dismiss} />);
  expect(screen.getByRole("status").textContent).toContain("not the previous process");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(dismiss).toHaveBeenCalledOnce();
  view.rerender(<RestoredHistoryNotice remote onDismiss={dismiss} />);
  expect(screen.getByRole("status").textContent).toContain("new SSH terminal");
});
