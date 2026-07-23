import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FileExplorer, sortExplorerEntries } from "@/ui/FileExplorer";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";

describe("FileExplorer directory navigation", () => {
  test.each([
    ["root", "/root", ["/root", "/"]],
    ["ordinary user", "/home/alice", ["/home/alice", "/home", "/"]],
  ])("lets an SSH %s session browse from its cwd to the filesystem root", async (_user, rootDir, expectedPaths) => {
    const readPaths: string[] = [];
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") {
        readPaths.push((payload as { path: string }).path);
        return [];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir={rootDir} remotePtyId={40} />);
    await waitFor(() => expect(readPaths[readPaths.length - 1]).toBe(expectedPaths[0]));

    for (const parent of expectedPaths.slice(1)) {
      const goUp = screen.getByRole("button", { name: "Go to parent" }) as HTMLButtonElement;
      expect(goUp.disabled).toBe(false);
      fireEvent.click(goUp);
      await waitFor(() => expect(readPaths[readPaths.length - 1]).toBe(parent));
    }

    expect((screen.getByRole("button", { name: "Go to parent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "/" }).getAttribute("aria-current")).toBe("page");
  });

  test("keeps a local explorer scoped to its starting directory", async () => {
    mockIPC((command) => {
      if (command === "fs_read_dir") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    await screen.findByText("Directory is empty");

    expect((screen.getByRole("button", { name: "Go to parent" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("FileExplorer workspace files", () => {
  test("opens a remote file as a workspace tab", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") {
        return [{ name: "fixture.md", kind: "file", size: 7, mtime: 0 }];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/tmp/repo" remotePtyId={41} />);
    const file = await screen.findByRole("button", { name: /^fixture\.md/ });
    fireEvent.click(file);

    expect(useUIStore.getState()).toMatchObject({
      activeFileTabId: "remote\0/tmp/repo/fixture.md",
      fileTabs: [{
        sessionId: "remote",
        filePath: "/tmp/repo/fixture.md",
        fileName: "fixture.md",
      }],
    });

    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    expect(screen.getByText("Open in terminal")).toBeTruthy();
    expect(screen.queryByText("Open with VS Code")).toBeNull();
  });

  test("sorts each file group by name or modified time in both directions", async () => {
    mockIPC((command) => {
      if (command === "fs_read_dir") {
        return [
          { name: "zeta.txt", kind: "file", size: 1, mtime: 1_000 },
          { name: "alpha.txt", kind: "file", size: 1, mtime: 3_000 },
        ];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    await screen.findByRole("button", { name: /^alpha\.txt/ });
    const paths = () => [...document.querySelectorAll<HTMLButtonElement>("button[data-file-path]")]
      .map((button) => button.dataset.filePath);
    expect(paths()).toEqual(["/tmp/repo/alpha.txt", "/tmp/repo/zeta.txt"]);

    fireEvent.click(screen.getByRole("button", { name: /^Modified/ }));
    expect(paths()).toEqual(["/tmp/repo/alpha.txt", "/tmp/repo/zeta.txt"]);
    expect(screen.getByRole("button", { name: "Modified, descending" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Modified, descending" }));
    expect(paths()).toEqual(["/tmp/repo/zeta.txt", "/tmp/repo/alpha.txt"]);
    expect(screen.getByRole("button", { name: "Modified, ascending" }).getAttribute("aria-pressed")).toBe("true");

    expect(sortExplorerEntries([
      { name: "zeta.txt", kind: "file", size: 1, mtime: 1_000 },
      { name: "alpha.txt", kind: "file", size: 1, mtime: 1_000 },
    ], "modified", "desc").map((entry) => entry.name)).toEqual(["alpha.txt", "zeta.txt"]);
  });

  test("offers explicit VS Code and safely quoted terminal actions", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    useSessionsStore.setState({
      activeSessionId: "local",
      sessions: [{ id: "local", title: "Terminal", dir: "/tmp/repo", branch: "", runState: "idle", updatedAt: 1 }],
    });
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "fs_read_dir") {
        return [{ name: "a;echo 'pwn'.txt", kind: "file", size: 1, mtime: 1_000 }];
      }
      if (command === "open_in_editor") return null;
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    const file = await screen.findByRole("button", { name: /^a;echo 'pwn'\.txt/ });
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByText("Open with VS Code"));
    await waitFor(() => expect(calls).toContainEqual({
      command: "open_in_editor",
      payload: { editor: "vscode", path: "/tmp/repo/a;echo 'pwn'.txt", line: undefined, column: undefined },
    }));

    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByText("Open in terminal"));
    expect(useSessionsStore.getState().sessions[0]).toMatchObject({
      pendingInput: "less -- 'a;echo '\"'\"'pwn'\"'\"'.txt'",
      pendingInputSubmit: true,
    });
  });

  test("retries a failed search without changing the query", async () => {
    let searchAttempts = 0;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "ssh_fs_search") {
        searchAttempts += 1;
        if (searchAttempts === 1) throw new Error("temporary search failure");
        return [{ path: "/tmp/repo/match.txt", rel: "match.txt", name: "match.txt", isDir: false }];
      }
      if (command === "fs_cancel_search") return true;
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/tmp/repo" remotePtyId={42} />);
    fireEvent.change(screen.getByPlaceholderText("Search current project"), { target: { value: "match" } });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: /^match\.txt/ })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search current project")).toHaveProperty("value", "match");
    expect(searchAttempts).toBe(2);
  });
});
