import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FilePreview } from "@/ui/FilePreview";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { requestActiveDirtyDraftAction } from "@/modules/editor/dirty-draft-guard";

const original = {
  kind: "text",
  content: "before\n",
  size: 7,
  fingerprint: "a".repeat(64),
} as const;

function renderLocal(fileName = "notes.txt") {
  render(<FilePreview filePath={`/tmp/${fileName}`} fileName={fileName} fill onClose={() => {}} />);
}

function renderSsh(fileName = "notes.txt") {
  render(<FilePreview filePath={`/tmp/${fileName}`} fileName={fileName} fill remotePtyId={41} onClose={() => {}} />);
}

describe("FilePreview editor behavior", () => {
  test("previews image bytes with loading, zoom, keyboard, and fullscreen states", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    mockIPC((command) => {
      if (command === "fs_read_file") {
        return { kind: "image", bytes: [137, 80, 78, 71], size: 4, mime: "image/png", width: 640, height: 480 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const view = render(<FilePreview filePath="/tmp/photo.png" fileName="photo.png" fill onClose={() => {}} />);
    expect((await screen.findByRole("status")).textContent).toContain("Loading image");
    const image = await screen.findByRole("img", { name: "photo.png" });
    expect(image.getAttribute("src")).toBe("blob:image-preview");
    fireEvent.load(image);
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("125%");
    const surface = screen.getByLabelText(/Image preview for photo.png/);
    fireEvent.keyDown(surface, { key: "0" });
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe("100%");
    fireEvent.keyDown(surface, { key: "f" });
    expect(screen.getByRole("dialog", { name: "Fullscreen image preview" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(surface));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(surface);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(surface);

    view.unmount();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-preview");
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  test("refuses images whose decoded dimensions exceed the memory budget", async () => {
    mockIPC((command) => {
      if (command === "fs_read_file") {
        return { kind: "imagetoolarge", size: 1024, width: 20_000, height: 20_000, maxPixels: 40_000_000 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal("oversized.png");
    expect((await screen.findByText(/dimensions are too large/i)).textContent).toContain("20000 × 20000");
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("renders notebooks as inert read-only previews", async () => {
    const script = "<script>globalThis.PWNED = true</script>";
    const notebook = JSON.stringify({
      nbformat: 4,
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: "# Notebook heading" },
        {
          cell_type: "code",
          execution_count: 2,
          source: "print('safe')",
          outputs: [
            { output_type: "stream", text: "safe output\n" },
            { output_type: "display_data", data: { "text/html": script } },
          ],
        },
      ],
    });
    mockIPC((command) => {
      if (command === "fs_read_file") {
        return { kind: "text", content: notebook, size: notebook.length, fingerprint: "a".repeat(64) };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal("analysis.ipynb");
    await screen.findByText("Notebook heading");
    expect(screen.getByText("Read-only notebook preview")).toBeTruthy();
    expect(screen.getByText("print('safe')")).toBeTruthy();
    expect(screen.getByText(/safe output/)).toBeTruthy();
    expect(screen.getByText("Rich output omitted for safety")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Edit analysis.ipynb" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByText(script)).toBeNull();
    expect((globalThis as { PWNED?: boolean }).PWNED).toBeUndefined();
  });

  test("shows the initial local read error and retries exactly once", async () => {
    let reads = 0;
    let finishRetry: ((value: typeof original) => void) | undefined;
    const retry = new Promise<typeof original>((resolve) => { finishRetry = resolve; });
    mockIPC((command) => {
      if (command !== "fs_read_file") throw new Error(`unexpected command: ${command}`);
      reads += 1;
      if (reads === 1) throw new Error("Permission denied (os error 13)");
      return retry;
    });

    renderLocal();
    await screen.findByText("Read failed");
    expect(screen.getByText(/cannot access this file/i)).toBeTruthy();
    expect(screen.getByText("Error: Permission denied (os error 13)")).toBeTruthy();

    const retryButton = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    expect(reads).toBe(2);

    finishRetry?.(original);
    await screen.findByRole("textbox", { name: "Edit notes.txt" });
    expect(screen.queryByText("Read failed")).toBeNull();
  });

  test("offers the owning SSH session as the recovery path after an initial disconnect", async () => {
    useSessionsStore.setState({
      activeSessionId: "remote-session",
      sessions: [{
        id: "remote-session",
        title: "Remote",
        dir: "/tmp",
        branch: "main",
        runState: "idle",
        remote: { host: "dev.example", port: 2202, user: "mawei", identityFile: "~/.ssh/id_ed25519" },
        ptyId: 41,
        updatedAt: 1,
      }],
    });
    useUIStore.setState({ overlay: null, sshPrefill: null });
    mockIPC((command) => {
      if (command === "ssh_fs_read_file") throw "no session for id 41";
      throw new Error(`unexpected command: ${command}`);
    });

    renderSsh();
    await screen.findByText("Read failed");
    expect(screen.getByText(/SSH connection is unavailable/i)).toBeTruthy();
    expect(screen.getByText("no session for id 41")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    expect(useUIStore.getState()).toMatchObject({
      overlay: "ssh",
      sshPrefill: {
        host: "dev.example",
        port: 2202,
        user: "mawei",
        identityFile: "~/.ssh/id_ed25519",
        reconnectSessionId: "remote-session",
      },
    });
  });

  test("saves a local draft through the fingerprint-safe IPC contract", async () => {
    const calls: Array<{ command: string; payload: unknown }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "fs_read_file") return original;
      if (command === "fs_write_text_file") {
        return { status: "saved", fingerprint: "b".repeat(64), size: 6 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal();
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    fireEvent.change(editor, { target: { value: "after\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved");
    expect(calls).toContainEqual({
      command: "fs_write_text_file",
      payload: {
        path: "/tmp/notes.txt",
        content: "after\n",
        expectedFingerprint: original.fingerprint,
      },
    });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps a pending guarded action when parent callbacks change identity", async () => {
    mockIPC((command) => {
      if (command === "fs_read_file") return original;
      throw new Error(`unexpected command: ${command}`);
    });
    const firstAttention = vi.fn();
    const secondAttention = vi.fn();
    const run = vi.fn();
    const view = render(
      <FilePreview sessionId="local" filePath="/tmp/notes.txt" fileName="notes.txt" fill onClose={() => {}} onNeedsAttention={firstAttention} />,
    );
    fireEvent.change(await screen.findByRole("textbox", { name: "Edit notes.txt" }), { target: { value: "draft\n" } });

    expect(requestActiveDirtyDraftAction(run)).toBe(false);
    expect(firstAttention).toHaveBeenCalledTimes(1);
    view.rerender(
      <FilePreview sessionId="local" filePath="/tmp/notes.txt" fileName="notes.txt" fill onClose={() => {}} onNeedsAttention={secondAttention} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("keeps the Markdown mode switch and save flow keyboard-complete", async () => {
    let writes = 0;
    mockIPC((command) => {
      if (command === "fs_read_file") return original;
      if (command === "fs_write_text_file") {
        writes += 1;
        return { status: "saved", fingerprint: "b".repeat(64), size: 14 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal("notes.md");
    await screen.findByRole("textbox", { name: "Edit notes.md" });
    const editTab = screen.getByRole("tab", { name: "Edit" });
    const previewTab = screen.getByRole("tab", { name: "Preview" });

    editTab.focus();
    fireEvent.keyDown(editTab, { key: "ArrowRight" });
    await waitFor(() => expect(previewTab.getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(previewTab);

    fireEvent.keyDown(previewTab, { key: "Home" });
    await waitFor(() => expect(editTab.getAttribute("aria-selected")).toBe("true"));
    expect(document.activeElement).toBe(editTab);

    const restoredEditor = await screen.findByRole("textbox", { name: "Edit notes.md" });
    fireEvent.change(restoredEditor, { target: { value: "keyboard save\n" } });
    fireEvent.keyDown(restoredEditor, { key: "s", ctrlKey: true });
    await screen.findByText("Saved");
    expect(writes).toBe(1);
  });

  test("keeps Markdown source visible while syntax highlighting is debounced", async () => {
    mockIPC((command) => {
      if (command === "fs_read_file") return original;
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal("notes.md");
    const editor = await screen.findByRole("textbox", { name: "Edit notes.md" });
    const visibleSource = document.querySelector<HTMLElement>(".file-editor-syntax");
    expect(visibleSource?.textContent).toBe("before\n");

    fireEvent.change(editor, { target: { value: "# live\n" } });
    expect(visibleSource?.textContent).toBe("# live\n");
  });

  test("keeps the draft on conflict and replaces it only after a successful reload", async () => {
    let reads = 0;
    mockIPC((command) => {
      if (command === "fs_read_file") {
        reads += 1;
        return reads === 1
          ? original
          : { ...original, content: "external\n", size: 9, fingerprint: "c".repeat(64) };
      }
      if (command === "fs_write_text_file") {
        return { status: "conflict", currentFingerprint: "c".repeat(64) };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal();
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "my draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("The file changed on disk");
    expect(editor.value).toBe("my draft\n");
    fireEvent.click(screen.getByRole("button", { name: "Reload file" }));

    await waitFor(() => expect(editor.value).toBe("external\n"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("contains an SSH reload rejection and explains the disconnected state", async () => {
    let reads = 0;
    mockIPC((command) => {
      if (command === "ssh_fs_read_file") {
        reads += 1;
        if (reads === 1) return original;
        throw "no session for id 41";
      }
      if (command === "ssh_fs_write_text_file") {
        return { status: "conflict", currentFingerprint: "d".repeat(64) };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderSsh();
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "remote draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The file changed on disk");
    fireEvent.click(screen.getByRole("button", { name: "Reload file" }));

    await screen.findByText("We couldn't reload this file");
    expect(screen.getByText(/connection is unavailable/i)).toBeTruthy();
    expect(screen.getByText("no session for id 41")).toBeTruthy();
    expect(editor.value).toBe("remote draft\n");
  });

  test("reports permission failure as a save error without losing the draft", async () => {
    mockIPC((command) => {
      if (command === "fs_read_file") return original;
      if (command === "fs_write_text_file") throw "Permission denied (os error 13)";
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal();
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "protected draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("We couldn't save this file");
    expect(screen.getByText(/cannot access this file/i)).toBeTruthy();
    expect(screen.getByText("Permission denied (os error 13)")).toBeTruthy();
    expect(editor.value).toBe("protected draft\n");
  });

  test("disables reload and suppresses duplicate reads while one is pending", async () => {
    let reads = 0;
    let finishReload: ((value: typeof original) => void) | undefined;
    const pendingReload = new Promise<typeof original>((resolve) => { finishReload = resolve; });
    mockIPC((command) => {
      if (command === "fs_read_file") {
        reads += 1;
        return reads === 1 ? original : pendingReload;
      }
      if (command === "fs_write_text_file") {
        return { status: "conflict", currentFingerprint: "e".repeat(64) };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal();
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    fireEvent.change(editor, { target: { value: "pending draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("The file changed on disk");

    const reload = screen.getByRole("button", { name: "Reload file" });
    fireEvent.click(reload);
    const pendingButton = await screen.findByRole("button", { name: "Reloading…" }) as HTMLButtonElement;
    expect(pendingButton.disabled).toBe(true);
    fireEvent.click(pendingButton);
    expect(reads).toBe(2);
    finishReload?.(original);
    await waitFor(() => expect(screen.queryByText("Reloading…")).toBeNull());
  });

  test("retains an unknown SSH save across a new PTY and reconciles with the replacement handle", async () => {
    const attemptedFingerprint = "f".repeat(64);
    const replaceLockOwner = "e".repeat(64);
    const token = `outcomeUnknown:${attemptedFingerprint}:640:lockOwner=${replaceLockOwner}:cleanupPending=true`;
    const calls: Array<{ command: string; payload: unknown }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload });
      if (command === "ssh_fs_read_file") return original;
      if (command === "ssh_fs_write_text_file") throw token;
      if (command === "ssh_fs_reconcile_text_write") {
        return { status: "saved", fingerprint: attemptedFingerprint, size: 13 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const first = render(
      <FilePreview filePath="/tmp/notes.txt" fileName="notes.txt" fill remotePtyId={41} onClose={() => {}} />,
    );
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" });
    fireEvent.change(editor, { target: { value: "remote draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Save result not confirmed");
    expect(screen.getByText(/temporary file may still need cleanup/i)).toBeTruthy();
    first.unmount();

    render(<FilePreview filePath="/tmp/notes.txt" fileName="notes.txt" fill remotePtyId={84} onClose={() => {}} />);
    const restored = await screen.findByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement;
    expect(restored.value).toBe("remote draft\n");
    await screen.findByText("Save result not confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Check remote result" }));

    await screen.findByText("Saved");
    expect(calls).toContainEqual({
      command: "ssh_fs_reconcile_text_write",
      payload: {
        id: 84,
        path: "/tmp/notes.txt",
        attemptedFingerprint,
        expectedMode: 0o640,
        replaceLockOwner,
      },
    });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("freezes an SSH draft across disconnect and never falls back to local file IPC", async () => {
    const calls: string[] = [];
    mockIPC((command) => {
      calls.push(command);
      if (command === "ssh_fs_read_file") return original;
      throw new Error(`unexpected command: ${command}`);
    });

    const view = render(
      <FilePreview sessionId="remote-draft" filePath="/srv/notes.txt" fileName="notes.txt" fill remote remotePtyId={41} onClose={() => {}} />,
    );
    const editor = await screen.findByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "preserved remote draft\n" } });

    view.rerender(
      <FilePreview sessionId="remote-draft" filePath="/srv/notes.txt" fileName="notes.txt" fill remote onClose={() => {}} />,
    );
    expect((screen.getByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement).value).toBe("preserved remote draft\n");
    expect(await screen.findByText("SSH disconnected · draft preserved")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Open in external editor" })).toBeNull();
    expect(calls).not.toContain("fs_read_file");
    expect(calls).not.toContain("fs_write_text_file");

    view.rerender(
      <FilePreview sessionId="remote-draft" filePath="/srv/notes.txt" fileName="notes.txt" fill remote remotePtyId={84} onClose={() => {}} />,
    );
    const restored = await screen.findByRole("textbox", { name: "Edit notes.txt" }) as HTMLTextAreaElement;
    expect(restored.value).toBe("preserved remote draft\n");
    expect(calls.filter((command) => command === "ssh_fs_read_file")).toHaveLength(2);
  });

  test("offers a 1000-line bounded local view without using download", async () => {
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    mockIPC((command, payload) => {
      calls.push({ command, payload: payload as Record<string, unknown> });
      if (command === "fs_read_file") return { kind: "toolarge", size: 50_000_000, limit: 10_485_760 };
      if (command === "fs_file_view_head_v1") {
        return {
          kind: "text",
          content: "line one\nline two\n",
          size: 50_000_000,
          revision: "r1",
          lineCount: 2,
          lineLimit: 1000,
          byteLimit: 262_144,
          truncated: true,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal("server.log");
    await screen.findByRole("button", { name: "View beginning" });
    expect((screen.getByRole("combobox", { name: "First lines" }) as HTMLSelectElement).value).toBe("1000");
    fireEvent.click(screen.getByRole("button", { name: "View beginning" }));

    await screen.findByText(/Showing 2 of up to 1000 lines/);
    expect(screen.getByText(/line one/)).toBeTruthy();
    const headCall = calls.find((call) => call.command === "fs_file_view_head_v1");
    expect(headCall?.payload).toMatchObject({ path: "/tmp/server.log", lineLimit: 1000 });
    expect(calls.some((call) => call.command.includes("download"))).toBe(false);
  });

  test("uses the complete ResourceRef SSH binding for a bounded view", async () => {
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const binding = {
      logicalSessionId: "ssh-session",
      physicalPtyId: 41,
      transportGeneration: "generation-7",
    };
    mockIPC((command, payload) => {
      calls.push({ command, payload: payload as Record<string, unknown> });
      if (command === "ssh_fs_read_file") return { kind: "toolarge", size: 12_000_000, limit: 10_485_760 };
      if (command === "ssh_file_view_head_v1") {
        return { kind: "text", content: "remote\n", size: 12_000_000, revision: "r2", lineCount: 1, lineLimit: 1000, byteLimit: 262_144, truncated: true };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FilePreview
      sessionId="ssh-session"
      filePath="/var/log/app.log"
      fileName="app.log"
      fill
      remote
      remotePtyId={41}
      resource={{ transport: "ssh", logicalSessionId: "ssh-session", binding, path: "/var/log/app.log" }}
      onClose={() => {}}
    />);
    fireEvent.click(await screen.findByRole("button", { name: "View beginning" }));
    await screen.findByText(/Showing 1 of up to 1000 lines/);

    expect(calls.find((call) => call.command === "ssh_file_view_head_v1")?.payload).toMatchObject({
      binding,
      path: "/var/log/app.log",
      lineLimit: 1000,
    });
  });

  test("cancels an in-flight bounded view through the server cancellation API", async () => {
    let resolveHead: ((value: unknown) => void) | undefined;
    const pendingHead = new Promise((resolve) => { resolveHead = resolve; });
    const commands: string[] = [];
    mockIPC((command) => {
      commands.push(command);
      if (command === "fs_read_file") return { kind: "toolarge", size: 20_000_000, limit: 10_485_760 };
      if (command === "fs_file_view_head_v1") return pendingHead;
      if (command === "fs_cancel_file_view_v1") return true;
      throw new Error(`unexpected command: ${command}`);
    });

    renderLocal("stream.log");
    fireEvent.click(await screen.findByRole("button", { name: "View beginning" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByText("The bounded view was cancelled.");
    expect(commands).toContain("fs_cancel_file_view_v1");
    resolveHead?.({ kind: "text", content: "late", size: 1, revision: "late", lineCount: 1, lineLimit: 1000, byteLimit: 262_144, truncated: false });
  });
});
