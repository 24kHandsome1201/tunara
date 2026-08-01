import { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { downloadFailureKey, FileExplorer, parseUploadFailure, sortExplorerEntries, uploadFailureKey } from "@/ui/FileExplorer";
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
        rejectUpload?.(new Error(`tunaraUploadError:${JSON.stringify({
          kind: "cancelled",
          message: "upload cancelled",
          residuePath: "/srv/app/.large.bin.tunara-cancelled-0.tmp",
        })}`));
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
    expect(toast?.subtitle).toContain("/srv/app/.large.bin.tunara-cancelled-0.tmp");
    expect(toast?.subtitle).not.toContain("may remain at /srv/app/large.bin.");
  });

  test.each(["partial", "changed", "uncertain"])("shows the exact hidden residue for an overwrite %s failure", async (kind) => {
    const destination = "/srv/app/existing.txt";
    const residue = "/srv/app/.existing.txt.tunara-deadbeef-0.tmp";
    let uploadCalls = 0;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "plugin:dialog|open") return "/home/alice/existing.txt";
      if (command === "plugin:dialog|message") return "Ok";
      if (command === "ssh_fs_upload") {
        uploadCalls += 1;
        if (uploadCalls === 1) return Promise.reject(new Error("remote destination already exists"));
        return Promise.reject(new Error(`tunaraUploadError:${JSON.stringify({ kind, message: "safe failure", residuePath: residue })}`));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={52} />);
    await screen.findByText("Directory is empty");
    fireEvent.click(screen.getByRole("button", { name: "Upload file…" }));

    await waitFor(() => expect(uploadCalls).toBe(2));
    const toasts = useUIStore.getState().toasts;
    const toast = toasts[toasts.length - 1];
    expect(toast?.subtitle).toContain(residue);
    expect(toast?.subtitle).not.toContain(`may remain at ${destination}.`);
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
    rejectUpload?.(new Error("remote destination already exists"));

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

  test("opens a remote file context menu from the keyboard and anchors it to the row", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [{ name: "keyboard.txt", kind: "file", size: 7, mtime: 0 }];
      throw new Error(`unexpected command: ${command}`);
    });
    render(<FileExplorer sessionId="remote" rootDir="/srv/app" remotePtyId={47} />);
    const file = await screen.findByRole("button", { name: /^keyboard\.txt/ });
    Object.defineProperty(file, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 120, right: 320, top: 40, bottom: 72, width: 200, height: 32, x: 120, y: 40, toJSON: () => ({}) }),
    });

    fireEvent.keyDown(file, { key: "F10", shiftKey: true });

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Download…")).toBeTruthy();
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
    const file = await screen.findByRole("button", { name: /^huge\.bin/ });
    fireEvent.contextMenu(file, { clientX: 20, clientY: 20 });

    const download = screen.getByRole("menuitem", { name: "Download unavailable (100 MiB limit)" });
    expect(download.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(download);
    expect(save).not.toHaveBeenCalled();
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
    const file = await screen.findByRole("button", { name: /^report\.txt/ });
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
    const file = await screen.findByRole("button", { name: /^report\.txt/ });

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
    const file = await screen.findByRole("button", { name: /^report\.txt/ });
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
    expect(uploadFailureKey(new Error("server does not support safe atomic overwrite"))).toBe("explorer.upload.error_unsupported_overwrite");
    expect(uploadFailureKey(new Error("destination permissions changed during upload"))).toBe("explorer.upload.error_changed");
    expect(uploadFailureKey(new Error("upload outcome unknown after replacement"))).toBe("explorer.upload.error_uncertain");
    expect(uploadFailureKey(new Error("a partial upload may remain"))).toBe("explorer.upload.error_partial");
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
    await screen.findByRole("button", { name: /^cached\.txt/ });
    view.rerender(<FileExplorer sessionId="remote" rootDir="/srv/app" remote />);

    expect(await screen.findByText("SSH disconnected · showing a read-only cached tree")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^cached\.txt/ })).toBeTruthy();
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
      const first = await screen.findByRole("button", { name: /^file-000\.txt/ });
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
