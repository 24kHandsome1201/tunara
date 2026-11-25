import { act, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { expect, test, vi } from "vitest";
import { isDirectoryLinkClick, registerTerminalFileLinkProvider } from "@/modules/terminal/lib/terminal-file-links";
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
  expect(useUIStore.getState().explorerHistory[owner.id]).toEqual({ paths: ["/previous/artifacts"], index: 0 });
  expect(useUIStore.getState()).toMatchObject({ panelVisible: true, inspectorTab: "files" });
  expect(useSessionsStore.getState().activeSessionId).toBe(owner.id);
  expect(useSessionsStore.getState().sessions[0].dir).toBe("/current");
});

test("directory links use ⌘+click on macOS, where Ctrl+click is a context-menu click", () => {
  const click = (init: MouseEventInit) => new MouseEvent("click", { button: 0, ...init });
  expect(isDirectoryLinkClick(click({ metaKey: true }), true)).toBe(true);
  expect(isDirectoryLinkClick(click({ ctrlKey: true }), true)).toBe(false);
  expect(isDirectoryLinkClick(click({ ctrlKey: true }), false)).toBe(true);
  expect(isDirectoryLinkClick(click({ metaKey: true }), false)).toBe(false);
  expect(isDirectoryLinkClick(click({ ctrlKey: true, metaKey: true }), false)).toBe(false);
  expect(isDirectoryLinkClick(click({ ctrlKey: true, button: 1 }), false)).toBe(false);
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

function fakeWrappedTerminal(rows: { text: string; isWrapped?: boolean }[]): { term: Terminal; provider: () => ILinkProvider } {
  let registered: ILinkProvider | null = null;
  const lines = rows.map(({ text, isWrapped = false }) => {
    // "\0" is an empty cell; Han characters take two cells, as in xterm.
    const cells = [...text].flatMap((char) => {
      if (char === "\0") return [{ getChars: () => "", getWidth: () => 1 }];
      if (/\p{Script=Han}/u.test(char)) return [{ getChars: () => char, getWidth: () => 2 }, { getChars: () => "", getWidth: () => 0 }];
      return [{ getChars: () => char, getWidth: () => 1 }];
    });
    const translateToString = (trimRight = false, start = 0, end = cells.length) => {
      const value = cells.slice(start, end).map((cell) => cell.getChars() || (cell.getWidth() ? " " : "")).join("");
      return trimRight ? value.trimEnd() : value;
    };
    return { isWrapped, length: cells.length, getCell: (x: number) => cells[x], translateToString };
  });
  const term = {
    buffer: { active: { getLine: (y: number) => lines[y] } },
    hasSelection: () => false,
    registerLinkProvider: (provider: ILinkProvider) => {
      registered = provider;
      return { dispose() {} };
    },
  } as unknown as Terminal;
  return { term, provider: () => registered! };
}

function linksForRow(provider: ILinkProvider, bufferLineNumber: number): ILink[] {
  let links: ILink[] | undefined;
  provider.provideLinks(bufferLineNumber, (value) => { links = value; });
  return links ?? [];
}

test("a file path soft-wrapped across rows is one link that opens the full path with its line and column", () => {
  const createResource = vi.fn(() => null);
  const getCwd = vi.fn(() => "~");
  const { term, provider } = fakeWrappedTerminal([
    { text: "error /home/dev/projec" },
    { text: "t/src/file.ts:12:3 bad", isWrapped: true },
  ]);
  registerTerminalFileLinkProvider(term, { getCwd, createResource });

  for (const row of [1, 2]) {
    const links = linksForRow(provider(), row);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("/home/dev/project/src/file.ts:12:3");
    expect(links[0].range).toEqual({ start: { x: 7, y: 1 }, end: { x: 18, y: 2 } });
    links[0].activate(new MouseEvent("click"), links[0].text);
  }
  expect(createResource).toHaveBeenNthCalledWith(1, "/home/dev/project/src/file.ts", 12, 3);
  expect(createResource).toHaveBeenNthCalledWith(2, "/home/dev/project/src/file.ts", 12, 3);
  expect(getCwd).toHaveBeenCalledWith(1);
});

test("rows split by a real line break keep their own links and cwd", () => {
  const createResource = vi.fn(() => null);
  const { term, provider } = fakeWrappedTerminal([
    { text: "/tmp/plain.ts:4 /home/dev/projec" },
    { text: "src/file.ts:12:3" },
  ]);
  registerTerminalFileLinkProvider(term, { getCwd: (row) => `/cwd-${row}`, createResource });

  const first = linksForRow(provider(), 1);
  expect(first.map((link) => link.text)).toEqual(["/tmp/plain.ts:4", "/home/dev/projec"]);
  const [second] = linksForRow(provider(), 2);
  expect(second).toMatchObject({ text: "src/file.ts:12:3", range: { start: { x: 1, y: 2 }, end: { x: 16, y: 2 } } });
  second.activate(new MouseEvent("click"), second.text);
  expect(createResource).toHaveBeenCalledWith("/cwd-2/src/file.ts", 12, 3);
});

test("the empty cell xterm leaves before a wrapped wide character is not part of the path", () => {
  const createResource = vi.fn(() => null);
  const { term, provider } = fakeWrappedTerminal([
    { text: "cd '/home/dev/\0" },
    { text: "项目/src' done", isWrapped: true },
  ]);
  registerTerminalFileLinkProvider(term, { getCwd: () => "~", createResource });

  const [link] = linksForRow(provider(), 2);
  expect(link).toMatchObject({ text: "/home/dev/项目/src", range: { start: { x: 5, y: 1 }, end: { x: 8, y: 2 } } });
  link.activate(new MouseEvent("click", { ctrlKey: true }), link.text);
  expect(createResource).toHaveBeenCalledWith("/home/dev/项目/src", undefined, undefined);
});

test("hovering a line that wraps across the scrollback reads a bounded window of rows", () => {
  const createResource = vi.fn(() => null);
  const filler = "x".repeat(20);
  const { term, provider } = fakeWrappedTerminal(Array.from({ length: 2000 }, (_, row) => ({
    text: row === 1000 ? " /tmp/a/b.ts:7:9    " : filler,
    isWrapped: row > 0,
  })));
  registerTerminalFileLinkProvider(term, { getCwd: () => "~", createResource });
  const getLine = vi.spyOn(term.buffer.active, "getLine");

  const [link] = linksForRow(provider(), 1001);
  expect(link).toMatchObject({ text: "/tmp/a/b.ts:7:9", range: { start: { x: 2, y: 1001 }, end: { x: 16, y: 1001 } } });
  link.activate(new MouseEvent("click"), link.text);
  expect(createResource).toHaveBeenCalledWith("/tmp/a/b.ts", 7, 9);
  expect(new Set(getLine.mock.calls.map(([y]) => y)).size).toBeLessThan(500);
});

const repeatRows = (count: number, text: string) => Array.from({ length: count }, () => text);

test.each<[string, number, string[]]>([
  ["file link cut by the window start", 1001, [...repeatRows(1000, "a/".repeat(10)), "b.ts:3:4 done".padEnd(20)]],
  ["directory link cut by the window start", 1001, [...repeatRows(1000, "/a".repeat(10)), "/ done".padEnd(20)]],
  // The window ends after "b.ts:12345", but the line goes on with "abc…", so that is not a line number.
  ["file link cut by the window end", 1, [`see ${"a/".repeat(8)}`, ...repeatRows(205, "a/".repeat(10)), "a/a/a/a/a/b.ts:12345", ...repeatRows(10, "abcdefghij".repeat(2))]],
  ["directory link cut by the window end", 1, [`see ${"/a".repeat(8)}`, ...repeatRows(220, "/a".repeat(10))]],
])("a %s is not a link, since its token goes on past the window", (_name, hover, rows) => {
  const { term, provider } = fakeWrappedTerminal(rows.map((text, row) => ({ text, isWrapped: row > 0 })));
  registerTerminalFileLinkProvider(term, { getCwd: () => "~", createResource: () => null });

  expect(linksForRow(provider(), hover)).toEqual([]);
});

test("a cut window with quotes yields no directory link, since its quote pairing is unknown", () => {
  const filler = "x".repeat(20);
  const { term, provider } = fakeWrappedTerminal(Array.from({ length: 2000 }, (_, row) => ({
    text: row === 0 ? `"${filler.slice(1)}` : row === 900 ? `${filler.slice(10)}"${filler.slice(11)}` : row === 1000 ? ` "/tmp/My Files" xxx` : filler,
    isWrapped: row > 0,
  })));
  registerTerminalFileLinkProvider(term, { getCwd: () => "~", createResource: () => null });

  expect(linksForRow(provider(), 1001)).toEqual([]);
});
