import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FilePreview } from "@/ui/FilePreview";

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
});
