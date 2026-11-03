import { act, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { expect, test, vi } from "vitest";
import { registerTerminalFileLinkProvider } from "@/modules/terminal/lib/terminal-file-links";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import type { Session } from "@/ui/types";

function fakeTerminal(text: string, hasSelection = false): { term: Terminal; provider: () => ILinkProvider } {
  let registered: ILinkProvider | null = null;
  const cells = [...text].map((char) => ({ getChars: () => char, getWidth: () => 1 }));
  const line = { length: cells.length, translateToString: () => text, getCell: (x: number) => cells[x] };
  const term = {
    buffer: { active: { getLine: () => line } },
    hasSelection: () => hasSelection,
    registerLinkProvider: (provider: ILinkProvider) => {
      registered = provider;
      return { dispose() {} };
    },
  } as unknown as Terminal;
  return { term, provider: () => registered! };
}

const owner: Session = { id: "link-owner", title: "Links", dir: "/current", branch: "", runState: "idle", updatedAt: 1 };

test("Ctrl+click uses the output line's cwd and opens its directory without changing shell cwd", async () => {
  useSessionsStore.setState({ sessions: [owner], activeSessionId: "another-pane" });
  useUIStore.setState({ panelVisible: false, inspectorTab: "changes" });
  mockIPC((command, payload) => {
    if (command === "fs_resolve_dir") return (payload as { path: string }).path;
    if (command === "fs_read_dir") return [];
    throw new Error(`unexpected command: ${command}`);
  });
  const { term, provider } = fakeTerminal("output: ../artifacts");
  registerTerminalFileLinkProvider(term, {
    getCwd: () => "/previous/project",
    createResource: (path) => resourceRefForSession(owner, path),
  });
  let links: ILink[] | undefined;
  provider().provideLinks(1, (value) => { links = value; });
  const ordinaryClick = new MouseEvent("click", { cancelable: true });
  links![0].activate(ordinaryClick, links![0].text);
  expect(ordinaryClick.defaultPrevented).toBe(false);
  expect(useUIStore.getState().panelVisible).toBe(false);
  links![0].activate(new MouseEvent("click", { ctrlKey: true }), links![0].text);
  await waitFor(() => expect(useUIStore.getState().explorerPaths[owner.id]).toBe("/previous/artifacts"));
  expect(useUIStore.getState()).toMatchObject({ panelVisible: true, inspectorTab: "files" });
  expect(useSessionsStore.getState().activeSessionId).toBe(owner.id);
  expect(useSessionsStore.getState().sessions[0].dir).toBe("/current");
});

test.each(["selection", "tui"])("directory links leave %s ownership untouched", (reason) => {
  const createResource = vi.fn();
  const { term, provider } = fakeTerminal("/tmp/output", reason === "selection");
  registerTerminalFileLinkProvider(term, {
    getCwd: () => "/work", shouldActivate: () => reason !== "tui", createResource,
  });
  let links: ILink[] | undefined;
  provider().provideLinks(1, (value) => { links = value; });
  const click = new MouseEvent("click", { ctrlKey: true, cancelable: true });
  links![0].activate(click, links![0].text);
  expect(click.defaultPrevented).toBe(false);
  expect(createResource).not.toHaveBeenCalled();
});

test("SSH directory links expand the remote home and never use local filesystem or editor IPC", async () => {
  const remote: Session = { ...owner, remote: { host: "example.test", port: 22, user: "deploy" },
    ptyId: 41, transportGeneration: "g1", connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 } };
  useSessionsStore.setState({ sessions: [remote], activeSessionId: remote.id });
  mockIPC((command, payload) => {
    if (command === "ssh_fs_home") return "/remote/home";
    if (command === "ssh_fs_read_dir" && (payload as { id: number; path: string }).id === 41
      && (payload as { path: string }).path === "/remote/home/My Files") return [];
    throw new Error(`unexpected IPC: ${command}`);
  });
  await openResource(resourceRefForSession(remote, "~/My Files"), "directory");
  expect(useUIStore.getState().explorerPaths[remote.id]).toBe("/remote/home/My Files");
});

test("failed directory reads and stale asynchronous SSH checks leave the explorer unchanged", async () => {
  const remote: Session = { ...owner, remote: { host: "example.test", port: 22, user: "deploy" },
    ptyId: 41, transportGeneration: "g1", connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 } };
  useSessionsStore.setState({ sessions: [remote], activeSessionId: remote.id });
  useUIStore.setState({ explorerPaths: { [remote.id]: "/before" } });
  mockIPC(() => { throw new Error("not a directory"); });
  await expect(openResource(resourceRefForSession(remote, "/a-file"), "directory")).rejects.toThrow("not a directory");
  let resolve!: (value: unknown[]) => void;
  mockIPC(() => new Promise<unknown[]>((done) => { resolve = done; }));
  const opening = openResource(resourceRefForSession(remote, "/target"), "directory");
  const rejected = expect(opening).rejects.toThrow("stale directory resource");
  useSessionsStore.setState({ sessions: [{ ...remote, transportGeneration: "g2" }] });
  await act(async () => { resolve([]); });
  await rejected;
  expect(useUIStore.getState().explorerPaths[remote.id]).toBe("/before");
});

test("a terminal file link that fails to open is logged and surfaced as an error toast", async () => {
  useUIStore.setState({ toasts: [] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { term, provider } = fakeTerminal("error at src/app.ts:12");
  registerTerminalFileLinkProvider(term, {
    getCwd: () => "/work",
    // The owning session no longer exists, so openResource rejects.
    createResource: (path, line, column) => ({ transport: "local", logicalSessionId: "gone", path, line, column }),
  });

  let links: ILink[] | undefined;
  provider().provideLinks(1, (value) => { links = value; });
  expect(links).toHaveLength(1);
  const event = new MouseEvent("click");
  links![0].activate(event, links![0].text);

  await waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1));
  expect(useUIStore.getState().toasts[0].sessionId).toBeUndefined();
  expect(useUIStore.getState().toasts[0]).toMatchObject({
    title: "Couldn't open this file",
    subtitle: "/work/src/app.ts",
    variant: "error",
  });
  expect(warn).toHaveBeenCalledWith("[terminal-file-links] open failed", "/work/src/app.ts", expect.any(Error));
  warn.mockRestore();
});
