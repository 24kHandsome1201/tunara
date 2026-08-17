import { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { downloadFailureKey, FileExplorer, parseUploadFailure, sortExplorerEntries, uploadFailureKey } from "@/ui/FileExplorer";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { useTransferStore } from "@/modules/ssh/transfer-store";

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

  test("follows the SSH terminal cwd until the host toggle is turned off", async () => {
    useSessionsStore.setState({
      activeSessionId: "remote",
      hostFilePrefs: {},
      sessions: [{
        id: "remote",
        title: "deploy@example",
        dir: "/srv/app",
        branch: "",
        runState: "idle",
        updatedAt: 1,
        remote: { host: "example", port: 22, user: "deploy" },
        ptyId: 40,
      }],
    });
    const readPaths: string[] = [];
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") {
        readPaths.push((payload as { path: string }).path);
        return [];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const view = render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={40} />);
    await waitFor(() => expect(readPaths).toContain("/srv/app"));
    const follow = screen.getByRole("button", { name: "Follow terminal directory" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");

    view.rerender(<FileExplorer sessionId="remote" rootDir="/var/log" remotePtyId={40} />);
    await waitFor(() => expect(readPaths).toContain("/var/log"));

    fireEvent.click(screen.getByRole("button", { name: "Follow terminal directory" }));
    expect(screen.getByRole("button", { name: "Follow terminal directory" }).getAttribute("aria-pressed")).toBe("false");
    const afterToggle = readPaths.length;
    view.rerender(<FileExplorer sessionId="remote" rootDir="/tmp" remotePtyId={40} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Follow terminal directory" }).getAttribute("aria-pressed")).toBe("false"));
    expect(readPaths.slice(afterToggle)).not.toContain("/tmp");
  });

  test("favorites the current remote directory for the host", async () => {
    useSessionsStore.setState({
      activeSessionId: "remote",
      hostFilePrefs: {},
      sessions: [{
        id: "remote",
        title: "deploy@example",
        dir: "/srv/app",
        branch: "",
        runState: "idle",
        updatedAt: 1,
        remote: { host: "example", port: 22, user: "deploy" },
        ptyId: 40,
      }],
    });
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={40} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Favorite this directory" }));
    expect(useSessionsStore.getState().hostFilePrefs["deploy@example:22"]?.favoritePaths).toEqual(["/srv/app"]);
  });

  test("groups chrome into directory, search, and remote tool bands", async () => {
    useSessionsStore.setState({
      activeSessionId: "remote",
      hostFilePrefs: {},
      sessions: [{
        id: "remote",
        title: "deploy@example",
        dir: "/srv/app",
        branch: "",
        runState: "idle",
        updatedAt: 1,
        remote: { host: "example", port: 22, user: "deploy" },
        ptyId: 40,
      }],
    });
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={40} transportGeneration="g1" />);
    await screen.findByText("Directory is empty");

    const nav = screen.getByRole("navigation", { name: "Directory" });
    expect(within(nav).getByRole("button", { name: "Go to parent" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Refresh file list" })).toBeTruthy();
    expect(within(nav).queryByRole("button", { name: "Follow terminal directory" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Show dotfiles" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Upload file…" })).toBeNull();

    const search = screen.getByRole("search", { name: "Search files" });
    expect(within(search).getByPlaceholderText("Search current project")).toBeTruthy();
    expect(within(search).getByRole("button", { name: "Show dotfiles" })).toBeTruthy();
    expect(within(search).queryByRole("button", { name: "Refresh file list" })).toBeNull();

    const tools = screen.getByRole("toolbar", { name: "Remote file tools" });
    expect(within(tools).getByRole("button", { name: "Follow terminal directory" })).toBeTruthy();
    expect(within(tools).getByRole("button", { name: "Favorite this directory" })).toBeTruthy();
    expect(within(tools).getByRole("button", { name: "Upload file…" })).toBeTruthy();
    expect(within(tools).queryByRole("button", { name: "Show dotfiles" })).toBeNull();
    expect(within(tools).queryByRole("button", { name: "Go to parent" })).toBeNull();
  });

  test("keeps local files to directory and search bands", async () => {
    mockIPC((command) => {
      if (command === "fs_read_dir") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    await screen.findByText("Directory is empty");

    expect(screen.getByRole("navigation", { name: "Directory" })).toBeTruthy();
    expect(within(screen.getByRole("search", { name: "Search files" })).getByRole("button", { name: "Show dotfiles" })).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "Remote file tools" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload file…" })).toBeNull();
  });

  test("jumps to a favorite remote directory from the places menu", async () => {
    const readPaths: string[] = [];
    useSessionsStore.setState({
      activeSessionId: "remote",
      hostFilePrefs: {
        "deploy@example:22": {
          favoritePaths: ["/var/log"],
          recentPaths: ["/tmp"],
          followTerminalCwd: false,
        },
      },
      sessions: [{
        id: "remote",
        title: "deploy@example",
        dir: "/srv/app",
        branch: "",
        runState: "idle",
        updatedAt: 1,
        remote: { host: "example", port: 22, user: "deploy" },
        ptyId: 40,
      }],
    });
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") {
        readPaths.push((payload as { path: string }).path);
        return [];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={40} />);
    await waitFor(() => expect(readPaths).toContain("/srv/app"));
    fireEvent.click(screen.getByRole("button", { name: "Favorite and recent directories" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "/var/log" }));
    await waitFor(() => expect(readPaths).toContain("/var/log"));
  });
});

describe("FileExplorer workspace files", () => {
  test("queues files and folders through the typed transfer intent path and prevents browser drop navigation", async () => {
    useTransferStore.setState({ items: [] });
    const calls: Array<{ command: string; payload: unknown }> = [];
    const createdDirectories = new Set<string>();
    let dialogOpen = 0;
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return ++dialogOpen === 1 ? "/home/alice/report.txt" : "/home/alice/project";
      if (command === "fs_read_dir") {
        if ((payload as { path: string }).path === "/home/alice/project") return [];
        throw new Error("not a directory");
      }
      if (command === "validate_manifest") return {
        files: [{ path: "nested", kind: "dir", bytes: 0 }, { path: "nested/a.txt", kind: "file", bytes: 2 }],
        totalBytes: 2,
      };
      if (command === "ssh_fs_stat_v1") {
        const path = (payload as { path: string }).path;
        if (path.endsWith(".txt") || ((path === "/srv/app/project" || path === "/srv/app/project/nested") && !createdDirectories.has(path))) throw new Error("SSH_REMOTE_FS_NOT_FOUND");
        return { path, kind: "directory", precondition: { kind: "directory" }, capability: {} };
      }
      if (command === "ssh_fs_mutate_v1") {
        const request = (payload as { request: { operationId: string; operation: { path: string } } }).request;
        createdDirectories.add(request.operation.path);
        return { operationId: request.operationId, status: "applied", message: "created", atomic: false };
      }
      if (command === "ssh_transfer_upload") return { outcome: { status: "completed", bytesTransferred: 2 } };
      throw new Error(`unexpected command: ${command}`);
    });

    const view = render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={52} transportGeneration="backend-generation" />);
    await screen.findByText("Directory is empty");
    expect(fireEvent.drop(view.container.firstElementChild!, { dataTransfer: { files: [] } })).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));
    await waitFor(() => expect(calls.some(({ command, payload }) => command === "ssh_transfer_upload"
      && (payload as { binding: { transportGeneration: string }; remotePath: string }).binding.transportGeneration === "backend-generation"
      && (payload as { remotePath: string }).remotePath === "/srv/app/report.txt")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Upload folder…" }));
    await waitFor(() => expect(calls.some(({ command, payload }) => command === "validate_manifest"
      && (payload as { source: { root: string } }).source.root === "/home/alice/project")).toBe(true));
    await waitFor(() => expect(calls.some(({ command, payload }) => command === "ssh_transfer_upload"
      && (payload as { remotePath: string }).remotePath === "/srv/app/project/nested/a.txt")).toBe(true));
    const operations = calls.filter(({ command }) => command === "ssh_fs_mutate_v1" || command === "ssh_transfer_upload");
    expect(operations.slice(-3).map(({ command }) => command)).toEqual([
      "ssh_fs_mutate_v1", "ssh_fs_mutate_v1", "ssh_transfer_upload",
    ]);
    expect(operations.slice(-3, -1).map(({ payload }) =>
      (payload as { request: { operation: { path: string } } }).request.operation.path,
    )).toEqual(["/srv/app/project", "/srv/app/project/nested"]);
  });

  test("applies rename-all to upload conflicts without sending overwrite", async () => {
    useTransferStore.setState({ items: [] });
    const uploads: Array<{ remotePath: string; overwrite: boolean }> = [];
    let confirmations = 0;
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return ["/tmp/a.txt", "/tmp/b.txt"];
      if (command === "plugin:dialog|message") return ++confirmations === 1 ? "Cancel" : "Ok";
      if (command === "fs_read_dir") throw new Error("not a directory");
      if (command === "ssh_fs_stat_v1") {
        const path = (payload as { path: string }).path;
        if (path.includes(" (1).")) throw new Error("SSH_REMOTE_FS_NOT_FOUND");
        return { path, kind: "file", precondition: { kind: "file", size: 1 }, capability: {} };
      }
      if (command === "ssh_transfer_upload") {
        uploads.push(payload as { remotePath: string; overwrite: boolean });
        return { outcome: { status: "completed", bytesTransferred: 1 } };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={54} transportGeneration="generation" remoteHost="deploy@example.com" />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));
    await waitFor(() => expect(uploads).toHaveLength(2));
    expect(uploads.map(({ remotePath, overwrite }) => [remotePath, overwrite])).toEqual([
      ["/srv/app/a (1).txt", false], ["/srv/app/b (1).txt", false],
    ]);
  });

  test("creates an empty uploaded folder and does not enqueue files when mkdir fails", async () => {
    useTransferStore.setState({ items: [] });
    let fail = false;
    const mutations: string[] = [];
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return fail ? "/tmp/broken" : "/tmp/empty";
      if (command === "fs_read_dir") return [];
      if (command === "validate_manifest") return { files: [], totalBytes: 0 };
      if (command === "ssh_fs_stat_v1") {
        const path = (payload as { path: string }).path;
        if (path === "/srv/app/empty" || path === "/srv/app/broken") throw new Error("SSH_REMOTE_FS_NOT_FOUND");
        return { path, kind: "directory", precondition: { kind: "directory" }, capability: {} };
      }
      if (command === "ssh_fs_mutate_v1") {
        const request = (payload as { request: { operationId: string; operation: { path: string } } }).request;
        mutations.push(request.operation.path);
        return { operationId: request.operationId, status: fail ? "conflict" : "applied", message: "typed", atomic: false };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={53} transportGeneration="generation" />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload folder…" }));
    await waitFor(() => expect(mutations).toEqual(["/srv/app/empty"]));
    expect(useTransferStore.getState().items).toEqual([]);

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Upload folder…" }));
    await waitFor(() => expect(mutations).toEqual(["/srv/app/empty", "/srv/app/broken"]));
    expect(useTransferStore.getState().items).toEqual([]);
    expect(screen.queryByText(/Queued .*broken/i)).toBeNull();
  });

  test("uploads a selected local file with progress and refreshes the remote directory", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    let reads = 0;
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "ssh_fs_read_dir") {
        reads += 1;
        return [];
      }
      if (command === "plugin:dialog|open") return "/home/alice/report.txt";
      if (command === "ssh_fs_upload") {
        const progress = (payload as { onProgress: Channel<{ transferred: number; total: number }> }).onProgress;
        progress.onmessage({ transferred: 4, total: 8 });
        return 8;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={42} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));

    await waitFor(() => expect(calls.some(({ command, payload }) => command === "ssh_fs_upload"
      && (payload as { localPath: string; remotePath: string; overwrite: boolean }).localPath === "/home/alice/report.txt"
      && (payload as { localPath: string; remotePath: string; overwrite: boolean }).remotePath === "/srv/app/report.txt"
      && !(payload as { localPath: string; remotePath: string; overwrite: boolean }).overwrite)).toBe(true));
    await waitFor(() => expect(reads).toBe(2));
    const toasts = useUIStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ sessionId: "remote", title: "Upload complete", variant: "success" });
  });

  test("uploads every file selected by a legacy SSH session and continues after one fails", async () => {
    useUIStore.setState({ toasts: [] });
    const uploads: Array<{ localPath: string; remotePath: string; overwrite: boolean }> = [];
    let pickerPayload: unknown;
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") {
        pickerPayload = payload;
        return ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"];
      }
      if (command === "ssh_fs_upload") {
        const upload = payload as { localPath: string; remotePath: string; overwrite: boolean };
        uploads.push(upload);
        if (upload.localPath.endsWith("b.txt")) throw new Error("SSH connection lost");
        return 4;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={143} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));

    await waitFor(() => expect(uploads).toHaveLength(3));
    expect(JSON.stringify(pickerPayload)).toContain('"multiple":true');
    expect(uploads.map(({ localPath, remotePath, overwrite }) => [localPath, remotePath, overwrite])).toEqual([
      ["/tmp/a.txt", "/srv/app/a.txt", false],
      ["/tmp/b.txt", "/srv/app/b.txt", false],
      ["/tmp/c.txt", "/srv/app/c.txt", false],
    ]);
    await waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(3));
    expect(useUIStore.getState().toasts.map(({ title, variant }) => [title, variant])).toEqual([
      ["Upload complete", "success"],
      ["Upload failed", "error"],
      ["Upload complete", "success"],
    ]);
  });

  test("throttles upload live announcements without duplicating terminal toasts", async () => {
    let progress: ((event: { transferred: number; total: number }) => void) | undefined;
    let rejectUpload: ((error: Error) => void) | undefined;
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return "/home/alice/archive.bin";
      if (command === "ssh_fs_upload") {
        progress = (payload as { onProgress: Channel<{ transferred: number; total: number }> }).onProgress.onmessage;
        return new Promise<number>((_resolve, reject) => { rejectUpload = reject; });
      }
      if (command === "ssh_fs_cancel_upload") {
        rejectUpload?.(new Error("upload cancelled"));
        return true;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    useUIStore.setState({ toasts: [] });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={142} />);
    await screen.findByText("Directory is empty");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));
      await act(async () => { await Promise.resolve(); });
      const announcement = document.querySelector<HTMLElement>("[data-transfer-announcement]");
      expect(announcement?.textContent).toBe("Upload progress: archive.bin, 0%");

      act(() => progress?.({ transferred: 5, total: 100 }));
      expect(announcement?.textContent).toBe("Upload progress: archive.bin, 0%");
      await vi.advanceTimersByTimeAsync(2_000);
      act(() => progress?.({ transferred: 7, total: 100 }));
      expect(announcement?.textContent).toBe("Upload progress: archive.bin, 7%");
      act(() => progress?.({ transferred: 19, total: 100 }));
      expect(announcement?.textContent).toBe("Upload progress: archive.bin, 19%");
      act(() => progress?.({ transferred: 25, total: 100 }));
      expect(announcement?.textContent).toBe("Upload progress: archive.bin, 25%");

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(announcement?.textContent).toBe("Cancelling upload…");
      await act(async () => { await Promise.resolve(); });
      expect(useUIStore.getState().toasts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancels an in-flight upload from the progress surface", async () => {
    let transferId = "";
    let rejectUpload: ((error: Error) => void) | undefined;
    const cancelled: string[] = [];
    let cancelAttempts = 0;
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return "/home/alice/large.bin";
      if (command === "ssh_fs_upload") {
        transferId = (payload as { transferId: string }).transferId;
        const progress = (payload as { onProgress: Channel<{ transferred: number; total: number }> }).onProgress;
        progress.onmessage({ transferred: 64, total: 1024 });
        return new Promise<number>((_resolve, reject) => { rejectUpload = reject; });
      }
      if (command === "ssh_fs_cancel_upload") {
        cancelAttempts += 1;
        // Exercise the real invoke race where cancellation can arrive just
        // before the backend has registered the transfer ID.
        if (cancelAttempts === 1) return false;
        cancelled.push((payload as { transferId: string }).transferId);
        rejectUpload?.(new Error("SSH_TRANSFER_CANCELLED"));
        return true;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={43} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));
    await screen.findByText(/Uploading large\.bin/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelled).toEqual([transferId]));
    expect(cancelAttempts).toBe(2);
    await waitFor(() => expect(screen.queryByText(/Uploading large\.bin/)).toBeNull());
    const toasts = useUIStore.getState().toasts;
    const toast = toasts[toasts.length - 1];
    expect(toast).toBeUndefined();
  });

  test.each([
    ["partial", "SSH_TRANSFER_PARTIAL"],
    ["changed", "SSH_TRANSFER_CHANGED"],
    ["uncertain", "SSH_TRANSFER_OUTCOME_UNKNOWN"],
  ])("shows a safe typed overwrite %s failure without backend paths", async (_kind, code) => {
    let uploadCalls = 0;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return "/home/alice/existing.txt";
      if (command === "plugin:dialog|message") return "Ok";
      if (command === "ssh_fs_upload") {
        uploadCalls += 1;
        if (uploadCalls === 1) return Promise.reject(new Error("SSH_TRANSFER_DESTINATION_EXISTS"));
        return Promise.reject(new Error(code));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={52} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));

    await waitFor(() => expect(uploadCalls).toBe(2));
    const toasts = useUIStore.getState().toasts;
    const toast = toasts[toasts.length - 1];
    expect(toast?.subtitle).not.toContain("/srv/");
  });

  test("does not offer an overwrite when cancellation wins the destination check race", async () => {
    let rejectUpload: ((error: Error) => void) | undefined;
    let uploadCalls = 0;
    let confirmCalls = 0;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return "/home/alice/existing.txt";
      if (command === "ssh_fs_upload") {
        uploadCalls += 1;
        return new Promise<number>((_resolve, reject) => { rejectUpload = reject; });
      }
      if (command === "ssh_fs_cancel_upload") return false;
      if (command === "plugin:dialog|message") {
        confirmCalls += 1;
        return true;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={44} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));
    await screen.findByText(/Uploading existing\.txt/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rejectUpload?.(new Error("SSH_TRANSFER_DESTINATION_EXISTS"));

    await waitFor(() => expect(screen.queryByText(/Uploading existing\.txt/)).toBeNull());
    expect(uploadCalls).toBe(1);
    expect(confirmCalls).toBe(0);
  });

  test("detaches stale upload UI when the remote PTY changes", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return "/home/alice/stale.bin";
      if (command === "ssh_fs_upload") return new Promise<number>(() => {});
      if (command === "ssh_fs_cancel_upload") return true;
      throw new Error(`unexpected command: ${command}`);
    });

    const view = render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={45} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));
    await screen.findByText(/Uploading stale\.bin/);

    view.rerender(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={46} />);
    await waitFor(() => expect(screen.queryByText(/Uploading stale\.bin/)).toBeNull());
    expect((screen.getByRole("button", { name: "Upload file…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("opens a remote file as a workspace tab", async () => {
    useSessionsStore.setState({
      sessions: [{
        id: "remote", title: "deploy@example", dir: "/tmp/repo", branch: "", runState: "idle", updatedAt: 1,
        remote: { host: "example", port: 22, user: "deploy" },
        ptyId: 41,
        transportGeneration: "open-file-generation",
      }],
      activeSessionId: "remote",
    });
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") {
        return [{ name: "fixture.md", kind: "file", size: 7, mtime: 0 }];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/tmp/repo" remotePtyId={41} transportGeneration="open-file-generation" />);
    const file = await screen.findByRole("treeitem", { name: /^fixture\.md/ });
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

  test("opens a remote file context menu from the keyboard and anchors it to the row", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "keyboard.txt", kind: "file", size: 7, mtime: 0 }];
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={47} />);
    const file = await screen.findByRole("treeitem", { name: /^keyboard\.txt/ });
    Object.defineProperty(file, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 120, right: 320, top: 40, bottom: 72, width: 200, height: 32, x: 120, y: 40, toJSON: () => ({}) }),
    });

    fireEvent.keyDown(file, { key: "F10", shiftKey: true });

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Download…")).toBeTruthy();
  });

  test("offers keyboard CRUD dialogs and restores the originating treeitem on Escape", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "report.txt", kind: "file", size: 3, mtime: 20 }];
      if (command === "ssh_fs_stat_v1") return {
        path: "/srv/app/report.txt",
        kind: "file",
        precondition: { kind: "file", size: 3, mode: 0o100644, modifiedAt: 20 },
        parentPrecondition: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
        mode: 0o100644,
        capability: { chmod: "unknown", handleSetstat: "unknown", posixRename: "unknown" },
      };
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={53} transportGeneration="backend-generation" remoteHost="deploy@example.com" />);
    const file = await screen.findByRole("treeitem", { name: /^report\.txt/ });

    file.focus();
    fireEvent.keyDown(file, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename remote item" }));
    const renameDialog = screen.getByRole("dialog", { name: "Rename remote item" });
    const nameInput = screen.getByRole("textbox", { name: "Name" });
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(document.activeElement).toBe(nameInput);
    fireEvent.keyDown(nameInput, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(continueButton);
    fireEvent.keyDown(continueButton, { key: "Tab" });
    expect(document.activeElement).toBe(nameInput);
    fireEvent.keyDown(renameDialog, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(file));

    fireEvent.keyDown(file, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete remote item" }));
    const deleteDialog = await screen.findByRole("dialog", { name: "Delete remote item" });
    expect(screen.getByText("deploy@example.com")).toBeTruthy();
    expect(screen.getByText("/srv/app/report.txt")).toBeTruthy();
    fireEvent.keyDown(deleteDialog, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(file));
  });

  test("drops a pending CRUD preparation when the transport binding changes", async () => {
    let resolveStat: ((value: unknown) => void) | undefined;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "stale.txt", kind: "file", size: 3, mtime: 20 }];
      if (command === "ssh_fs_stat_v1") return new Promise((resolve) => { resolveStat = resolve; });
      throw new Error(`unexpected command: ${command}`);
    });
    const view = render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={53} transportGeneration="first" remoteHost="deploy@example.com" />);
    const file = await screen.findByRole("treeitem", { name: /^stale\.txt/ });
    fireEvent.keyDown(file, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename remote item" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    view.rerender(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={54} transportGeneration="second" remoteHost="deploy@example.com" />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename remote item" })).toBeNull());
    await act(async () => resolveStat?.({
      path: "/srv/app/stale.txt",
      kind: "file",
      precondition: { kind: "file", size: 3, mode: 0o100644, modifiedAt: 20 },
      parentPrecondition: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
      mode: 0o100644,
      capability: {},
    }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("closes an open CRUD confirmation when the transport binding changes", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "stale.txt", kind: "file", size: 3, mtime: 20 }];
      if (command === "ssh_fs_stat_v1") return {
        path: "/srv/app/stale.txt",
        kind: "file",
        precondition: { kind: "file", size: 3, mode: 0o100644, modifiedAt: 20 },
        parentPrecondition: { kind: "directory", mode: 0o40755, modifiedAt: 10 },
        mode: 0o100644,
        capability: {},
      };
      throw new Error(`unexpected command: ${command}`);
    });
    const view = render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={53} transportGeneration="first" remoteHost="deploy@example.com" />);
    const file = await screen.findByRole("treeitem", { name: /^stale\.txt/ });
    fireEvent.keyDown(file, { key: "F10", shiftKey: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete remote item" }));
    expect(await screen.findByRole("dialog", { name: "Delete remote item" })).toBeTruthy();

    view.rerender(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={54} transportGeneration="second" remoteHost="deploy@example.com" />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete remote item" })).toBeNull());
  });

  test("blocks known oversized downloads before choosing a destination", async () => {
    const save = vi.fn();
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "huge.bin", kind: "file", size: 100 * 1024 * 1024 + 1, mtime: 0 }];
      if (command === "plugin:dialog|save") {
        save();
        return "/tmp/huge.bin";
      }
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={48} />);
    const file = await screen.findByRole("treeitem", { name: /^huge\.bin/ });
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });

    const download = screen.getByRole("menuitem", { name: "Download unavailable (100 MiB limit)" });
    expect(download.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(download);
    expect(save).not.toHaveBeenCalled();
  });

  test("selects multiple remote files and queues safe typed downloads into one folder", async () => {
    useTransferStore.setState({ items: [] });
    const downloads: Array<{ remotePath: string; localPath: string; binding: { transportGeneration: string } }> = [];
    mockIPC((command, payload) => {
      const path = (payload as { path?: string }).path;
      if (command === "ssh_fs_read_dir") return [
        { name: "report.txt", kind: "file", size: 8, mtime: 0 },
        { name: "notes.txt", kind: "file", size: 12, mtime: 0 },
        { name: "huge.bin", kind: "file", size: 100 * 1024 * 1024 + 1, mtime: 0 },
      ];
      if (command === "plugin:dialog|open") return "/home/alice/Downloads";
      if (command === "fs_read_dir" && path === "/home/alice/Downloads") {
        return [{ name: "report.txt", kind: "file", size: 1, mtime: 0 }];
      }
      if (command === "ssh_transfer_download") {
        downloads.push(payload as typeof downloads[number]);
        return { outcome: { status: "completed", bytesTransferred: 8 } };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={55} transportGeneration="download-generation" />);
    await screen.findByRole("treeitem", { name: /^report\.txt/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all downloadable files" }));

    expect(screen.getByRole("checkbox", { name: "Select report.txt for download" }).getAttribute("aria-checked")).not.toBe("false");
    expect((screen.getByRole("checkbox", { name: "Select huge.bin for download" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Download selected files (2)" }));

    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads.map(({ remotePath, localPath, binding }) => [remotePath, localPath, binding.transportGeneration])).toEqual([
      ["/srv/app/notes.txt", "/home/alice/Downloads/notes.txt", "download-generation"],
      ["/srv/app/report.txt", "/home/alice/Downloads/report (1).txt", "download-generation"],
    ]);
    expect(useTransferStore.getState().items.every(({ batchId }) => typeof batchId === "string")).toBe(true);
  });

  test("shows an immediate indeterminate download state and clears it on completion", async () => {
    let finish: ((bytes: number) => void) | undefined;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "report.txt", kind: "file", size: 8, mtime: 0 }];
      if (command === "plugin:dialog|save") return "/tmp/report.txt";
      if (command === "ssh_fs_download") return new Promise<number>((resolve) => { finish = resolve; });
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={49} />);
    const file = await screen.findByRole("treeitem", { name: /^report\.txt/ });
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByText("Download…"));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Downloading report.txt");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("progressbar", { name: "Remote file download in progress" })).toBeTruthy();
    useSessionsStore.setState({ activeSessionId: "another-session" });
    finish?.(8);
    await waitFor(() => expect(screen.queryByText(/Downloading report\.txt/)).toBeNull());
    const toasts = useUIStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({ sessionId: "remote", title: "Download complete", variant: "success" });
  });

  test("locks download before the destination chooser resolves", async () => {
    let finishChooser: ((path: string | null) => void) | undefined;
    const chooser = vi.fn(() => new Promise<string | null>((resolve) => { finishChooser = resolve; }));
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "report.txt", kind: "file", size: 8, mtime: 0 }];
      if (command === "plugin:dialog|save") return chooser();
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={50} />);
    const file = await screen.findByRole("treeitem", { name: /^report\.txt/ });

    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByText("Download…"));
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByText("Download…"));

    expect(chooser).toHaveBeenCalledOnce();
    finishChooser?.(null);
  });

  test("reports a destination chooser failure without leaking the raw error", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "report.txt", kind: "file", size: 8, mtime: 0 }];
      if (command === "plugin:dialog|save") throw new Error("native chooser secret detail");
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={51} />);
    const file = await screen.findByRole("treeitem", { name: /^report\.txt/ });
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByText("Download…"));

    await waitFor(() => {
      const toasts = useUIStore.getState().toasts;
      const toast = toasts[toasts.length - 1];
      expect(toast).toMatchObject({ title: "Download failed", variant: "error" });
      expect(toast?.subtitle).toBe("Check the SSH connection, destination permissions, and available disk space.");
    });
  });

  test("maps download failures to actionable localized message keys", () => {
    expect(downloadFailureKey(new Error("destination already exists"))).toBe("explorer.download.error_exists");
    expect(downloadFailureKey(new Error("remote file exceeds download limit (100 MiB)"))).toBe("explorer.download.error_limit");
    expect(downloadFailureKey(new Error("opaque backend failure"))).toBe("explorer.download.failed_hint");
  });

  test("maps upload safety failures to actionable localized message keys", () => {
    expect(uploadFailureKey(new Error("SSH_TRANSFER_UNSUPPORTED"))).toBe("explorer.upload.error_unsupported_overwrite");
    expect(uploadFailureKey(new Error("SSH_TRANSFER_CHANGED"))).toBe("explorer.upload.error_changed");
    expect(uploadFailureKey(new Error("SSH_TRANSFER_OUTCOME_UNKNOWN"))).toBe("explorer.upload.error_uncertain");
    expect(uploadFailureKey(new Error("SSH_TRANSFER_PARTIAL"))).toBe("explorer.upload.error_partial");
    expect(uploadFailureKey(new Error("opaque backend failure"))).toBe("explorer.upload.failed_hint");
  });

  test.each(["cancelled", "partial", "changed", "uncertain"])("keeps the backend residue path for %s upload errors", (kind) => {
    const destination = "/srv/report.txt";
    const residue = "/srv/.report.txt.tunara-a1b2-0.tmp";
    const error = new Error(`tunaraUploadError:${JSON.stringify({ kind, message: "safe failure", residuePath: residue })}`);
    expect(parseUploadFailure(error)).toEqual({ kind, residuePath: residue });
    expect(parseUploadFailure(error).residuePath).not.toBe(destination);
  });

  test("keeps the cached remote tree inert while its PTY generation is disconnected", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "ssh_fs_read_dir") {
        return [{ name: "cached.txt", kind: "file", size: 7, mtime: 0 }];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const view = render(<FileExplorer sessionId="remote" rootDir="/srv/app" remote remotePtyId={41} />);
    await screen.findByRole("treeitem", { name: /^cached\.txt/ });
    view.rerender(<FileExplorer sessionId="remote" rootDir="/srv/app" remote />);

    expect(await screen.findByText("SSH disconnected · showing a read-only cached tree")).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /^cached\.txt/ })).toBeTruthy();
    expect(calls).not.toContain("fs_read_dir");
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
    await screen.findByRole("treeitem", { name: /^alpha\.txt/ });
    const paths = () => [...document.querySelectorAll<HTMLElement>("[role=treeitem][data-file-path]")]
      .map((item) => item.dataset.filePath);
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

  test("exposes tree hierarchy metadata and supports lazy tree keyboard navigation", async () => {
    const reads: string[] = [];
    mockIPC((command, payload) => {
      if (command !== "fs_read_dir") throw new Error(`unexpected command: ${command}`);
      const path = (payload as { path: string }).path;
      reads.push(path);
      if (path === "/tmp/repo") return [
        { name: "src", kind: "dir", size: 0, mtime: 2_000 },
        { name: "README.md", kind: "file", size: 1, mtime: 1_000 },
      ];
      return [{ name: "index.ts", kind: "file", size: 1, mtime: 1_000 }];
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    const tree = await screen.findByRole("tree", { name: "Files and directories" });
    const src = screen.getByRole("treeitem", { name: /^src/ });
    const readme = screen.getByRole("treeitem", { name: /^README\.md/ });
    expect([src.tabIndex, readme.tabIndex]).toEqual([0, -1]);
    expect(src.getAttribute("aria-level")).toBe("1");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    expect(src.getAttribute("aria-setsize")).toBe("2");
    expect(src.getAttribute("aria-posinset")).toBe("1");
    expect(reads).toEqual(["/tmp/repo"]);

    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    const child = await screen.findByRole("treeitem", { name: /^index\.ts/ });
    expect(reads).toEqual(["/tmp/repo", "/tmp/repo/src"]);
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(child.getAttribute("aria-level")).toBe("2");
    expect(src.querySelector('[role="group"]')?.contains(child)).toBe(true);
    expect(tree.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    fireEvent.keyDown(src, { key: "ArrowRight" });
    expect(document.activeElement).toBe(child);
    fireEvent.keyDown(child, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(src);
    fireEvent.keyDown(src, { key: "End" });
    expect(document.activeElement).toBe(readme);
    fireEvent.keyDown(readme, { key: "Home" });
    expect(document.activeElement).toBe(src);
  });

  test("expands a folder from the chevron without navigating into it", async () => {
    const reads: string[] = [];
    mockIPC((command, payload) => {
      if (command !== "fs_read_dir") throw new Error(`unexpected command: ${command}`);
      const path = (payload as { path: string }).path;
      reads.push(path);
      if (path === "/tmp/repo") return [
        { name: "src", kind: "dir", size: 0, mtime: 2_000 },
        { name: "README.md", kind: "file", size: 1, mtime: 1_000 },
      ];
      return [{ name: "index.ts", kind: "file", size: 1, mtime: 1_000 }];
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    const src = await screen.findByRole("treeitem", { name: /^src/ });
    expect(src.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Expand src" }));
    expect(await screen.findByRole("treeitem", { name: /^index\.ts/ })).toBeTruthy();
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(reads).toEqual(["/tmp/repo", "/tmp/repo/src"]);
    expect(screen.getByRole("button", { name: "repo" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(src);
    await waitFor(() => expect(reads[reads.length - 1]).toBe("/tmp/repo/src"));
    expect(screen.getByRole("button", { name: "src" }).getAttribute("aria-current")).toBe("page");
  });

  test("retries a rejected nested directory read instead of caching an empty result", async () => {
    let nestedAttempts = 0;
    let rejectFirst!: (error: Error) => void;
    mockIPC((command, payload) => {
      if (command !== "fs_read_dir") throw new Error(`unexpected command: ${command}`);
      const path = (payload as { path: string }).path;
      if (path === "/tmp/repo") return [{ name: "src", kind: "dir", size: 0, mtime: 0 }];
      nestedAttempts += 1;
      if (nestedAttempts === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      return [{ name: "recovered.ts", kind: "file", size: 1, mtime: 0 }];
    });

    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    const src = await screen.findByRole("treeitem", { name: /^src/ });
    src.focus();
    fireEvent.keyDown(src, { key: "ArrowRight" });
    act(() => rejectFirst(new Error("temporary read failure")));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("treeitem", { name: /^recovered\.ts/ })).toBeTruthy();
    expect(nestedAttempts).toBe(2);
  });

  test("supports typeahead and restores focus after closing a keyboard context menu", async () => {
    mockIPC((command) => command === "fs_read_dir" ? [
      { name: "alpha.txt", kind: "file", size: 1, mtime: 0 },
      { name: "beta.txt", kind: "file", size: 1, mtime: 0 },
    ] : (() => { throw new Error(`unexpected command: ${command}`); })());
    render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
    const alpha = await screen.findByRole("treeitem", { name: /^alpha\.txt/ });
    const beta = screen.getByRole("treeitem", { name: /^beta\.txt/ });
    vi.useFakeTimers();
    try {
      alpha.focus();
      fireEvent.keyDown(alpha, { key: "b" });
      expect(document.activeElement).toBe(beta);
      await vi.advanceTimersByTimeAsync(501);
      fireEvent.keyDown(beta, { key: "a" });
      expect(document.activeElement).toBe(alpha);
      fireEvent.keyDown(alpha, { key: "F10", shiftKey: true });
      expect(screen.getByRole("menu")).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await vi.runAllTimersAsync();
      expect(document.activeElement).toBe(alpha);
    } finally { vi.useRealTimers(); }
  });

  test("moves keyboard focus across a virtualized directory slice", async () => {
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return this.classList.contains("scroll-fade-y") ? 96 : 0; },
    });
    mockIPC((command) => {
      if (command === "fs_read_dir") {
        return Array.from({ length: 101 }, (_, index) => ({
          name: `file-${String(index).padStart(3, "0")}.txt`,
          kind: "file",
          size: 1,
          mtime: index,
        }));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    try {
      render(<FileExplorer sessionId="local" rootDir="/tmp/repo" />);
      const first = await screen.findByRole("treeitem", { name: /^file-000\.txt/ });
      first.focus();
      for (let index = 1; index <= 11; index += 1) {
        fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
        await waitFor(() => expect(document.activeElement?.textContent).toContain(`file-${String(index).padStart(3, "0")}.txt`));
      }
    } finally {
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
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
    const file = await screen.findByRole("treeitem", { name: /^a;echo 'pwn'\.txt/ });
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
