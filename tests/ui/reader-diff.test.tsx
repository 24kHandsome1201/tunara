import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { DiffPanel, ReaderDiff } from "@/ui/DiffPanel";
import { ReaderPane } from "@/ui/ReaderPane";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import { registerDirtyDraft, confirmDirtyDraftDiscard } from "@/modules/editor/dirty-draft-guard";
import type { Session } from "@/ui/types";
import type { FileDiff } from "@/modules/git/git-bridge";
import type { ReaderDiffRef } from "@/modules/session/reader-state";

vi.mock("@/modules/editor/syntax-highlight", () => ({ highlightDiffBodies: async () => null }));
const session: Session = { id: "diff-reader", title: "Terminal 1", dir: "/project", branch: "main", runState: "idle", updatedAt: 1, gitState: "repo", changes: { files: [{ path: "app.ts", stage: "unstaged", status: "M", added: 1, removed: 1 }] } };
const diffRef: ReaderDiffRef = { stage: "unstaged", repoPath: "/project", relativePath: "app.ts" };
const patch = (name: string): FileDiff => ({ kind: "text", path: "app.ts", patch: `@@ -1 +1 @@\n-old\n+${name}\n`, truncated: false, totalLines: 3 });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id, gitNonce: {} });
  useUIStore.setState({ readers: {}, split: { root: null }, toasts: [] });
});

test("a change opens the shared reader, and file/diff navigation retains separate history", async () => {
  const calls: string[] = [];
  mockIPC((command) => { calls.push(command); return command === "git_diff" ? patch("new content") : null; });
  const list = render(<DiffPanel session={session} embedded />);
  fireEvent.click(screen.getByRole("button", { name: "app.ts" }));
  expect(useUIStore.getState().readers[session.id].current?.diff).toEqual(diffRef);
  expect(calls).not.toContain("git_diff");
  list.unmount();
  render(<ReaderPane session={session} active />);
  expect(await screen.findByText("+new content")).toBeTruthy();
  await act(async () => { await openResource(resourceRefForSession(session, "/project/app.ts"), "preview"); });
  expect(useUIStore.getState().readers[session.id].history).toHaveLength(2);
  act(() => useUIStore.getState().readerHistoryBack(session.id));
  expect(useUIStore.getState().readers[session.id].current?.diff).toEqual(diffRef);
});

test("same-path diff navigation cannot discard an unsaved file", async () => {
  useUIStore.getState().openReader({ sessionId: session.id, filePath: "/project/app.ts", fileName: "app.ts" });
  const owner = Symbol("draft");
  const confirm = vi.fn();
  const unregister = registerDirtyDraft({ owner, sessionId: session.id, filePath: "/project/app.ts", dirty: true, requestConfirmation: confirm });
  const ref = { ...resourceRefForSession(session, "/project/app.ts"), diff: diffRef };
  await openResource(ref, "preview");
  expect(confirm).toHaveBeenCalledOnce();
  expect(useUIStore.getState().readers[session.id].current?.diff).toBeUndefined();
  expect(confirmDirtyDraftDiscard(owner)).toBe(true);
  expect(useUIStore.getState().readers[session.id].current?.diff).toEqual(diffRef);
  unregister();
});

test("late responses cannot replace a newly selected diff; repo path does not follow cwd", async () => {
  let resolveFirst!: (value: FileDiff) => void;
  const calls: unknown[] = [];
  mockIPC((command, payload) => {
    if (command !== "git_diff") return null;
    calls.push(payload);
    if (calls.length === 1) return new Promise<FileDiff>((resolve) => { resolveFirst = resolve; });
    return patch("second result");
  });
  const view = render(<ReaderDiff session={session} diffRef={diffRef} findRequest={0} />);
  await waitFor(() => expect(calls).toHaveLength(1));
  view.rerender(<ReaderDiff session={{ ...session, dir: "/elsewhere" }} diffRef={{ ...diffRef, stage: "staged" }} findRequest={0} />);
  expect(await screen.findByText("+second result")).toBeTruthy();
  await act(async () => resolveFirst(patch("stale result")));
  expect(screen.queryByText("+stale result")).toBeNull();
  expect(calls[1]).toMatchObject({ repoPath: "/project", stage: "staged" });
});

test("SSH disconnect cancels reads, never uses local Git, and reconnect uses the new binding", async () => {
  const remote: Session = { ...session, remote: { user: "deploy", host: "example.test", port: 22 }, ptyId: 42, transportGeneration: "first", connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 } };
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => { calls.push({ command, payload }); return command === "ssh_git_diff" ? patch("remote content") : true; });
  useSessionsStore.setState({ sessions: [remote] });
  const view = render(<ReaderDiff session={remote} diffRef={diffRef} findRequest={0} />);
  expect(await screen.findByText("+remote content")).toBeTruthy();
  const offline: Session = { ...remote, connection: { transport: "ssh", phase: "disconnected", source: "backend", updatedAt: 2 } };
  act(() => useSessionsStore.setState({ sessions: [offline] }));
  view.rerender(<ReaderDiff session={offline} diffRef={diffRef} findRequest={0} />);
  expect(screen.getByRole("status").textContent).toContain("Disconnected");
  expect(calls.some((call) => call.command === "fs_cancel_search")).toBe(true);
  const reconnected = { ...remote, ptyId: 43, transportGeneration: "second" };
  act(() => useSessionsStore.setState({ sessions: [reconnected] }));
  view.rerender(<ReaderDiff session={reconnected} diffRef={diffRef} findRequest={0} />);
  expect(await screen.findByText("+remote content")).toBeTruthy();
  expect(calls.filter((call) => call.command === "ssh_git_diff").slice(-1)[0]?.payload).toMatchObject({ sessionId: 43 });
  expect(calls.some((call) => call.command === "git_diff" || call.command === "open_in_editor")).toBe(false);
});

test("diff errors can be retried and copy failure is not reported as success", async () => {
  let attempt = 0;
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("clipboard unavailable"));
  mockIPC((command) => {
    if (command === "git_diff") { if (++attempt === 1) throw new Error("permission denied"); return patch("retried"); }
    throw new Error("clipboard unavailable");
  });
  render(<ReaderDiff session={session} diffRef={diffRef} findRequest={0} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("+retried")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy this hunk" }));
  await waitFor(() => expect(useUIStore.getState().toasts.slice(-1)[0]?.variant).toBe("error"));
});

test("diff search waits for committed IME text before filtering", async () => {
  mockIPC((command) => command === "git_diff" ? patch("alpha") : null);
  render(<ReaderDiff session={session} diffRef={diffRef} findRequest={0} />);
  expect(await screen.findByText("+alpha")).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "Search in this file…" });
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "zzz" } });
  expect((input as HTMLInputElement).value).toBe("zzz");
  expect(screen.getByText("+alpha")).toBeTruthy();
  fireEvent.compositionEnd(input, { target: { value: "zzz" } });
  await waitFor(() => expect(screen.queryByText("+alpha")).toBeNull());
});
