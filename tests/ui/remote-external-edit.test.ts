import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openRemoteInExternalEditor, stopRemoteExternalEdit } from "@/modules/ssh/remote-external-edit";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

const binding = {
  logicalSessionId: "remote-edit",
  physicalPtyId: 47,
  transportGeneration: "ssh:generation",
};

beforeEach(() => {
  vi.useFakeTimers();
  useUIStore.setState({ toasts: [], readers: {}, focusedPaneId: null });
  useSessionsStore.setState({
    sessions: [{
      id: "remote-edit",
      title: "deploy@example",
      dir: "/srv/app",
      branch: "main",
      runState: "idle",
      updatedAt: 1,
      ptyId: 47,
      transportGeneration: "ssh:generation",
      remote: { host: "example", port: 22, user: "deploy", authMethod: "agent" },
      connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
    }],
    activeSessionId: "remote-edit",
  });
});

afterEach(() => {
  stopRemoteExternalEdit("remote-edit");
  vi.useRealTimers();
});

test("stops external-editor sync on conflict and exposes the preserved local copy", async () => {
  let localContent = "before";
  let writes = 0;
  let editorPayload: unknown;
  mockIPC((command, payload) => {
    if (command === "remote_edit_staging_path") return "/tmp/tunara-staged.txt";
    if (command === "ssh_fs_read_file") {
      return { kind: "text", content: "before", size: 6, fingerprint: "remote-v1" };
    }
    if (command === "ssh_fs_download") return 6;
    if (command === "open_in_editor") {
      editorPayload = payload;
      return null;
    }
    if (command === "fs_read_file") {
      return { kind: "text", content: localContent, size: localContent.length, fingerprint: "local" };
    }
    if (command === "ssh_fs_write_text_file") {
      writes += 1;
      return { status: "conflict", currentFingerprint: "remote-v2" };
    }
    throw new Error(`unexpected command: ${command}`);
  });

  await openRemoteInExternalEditor({
    sessionId: "remote-edit",
    binding,
    remotePath: "/srv/app/report.txt",
    editor: "vscode",
  });
  expect(editorPayload).toEqual({
    editor: "vscode",
    path: "/tmp/tunara-staged.txt",
    line: undefined,
    column: undefined,
  });

  localContent = "after";
  await vi.advanceTimersByTimeAsync(1_200);

  expect(writes).toBe(1);
  const failure = useUIStore.getState().toasts.find((toast) => toast.variant === "error");
  expect(failure).toMatchObject({
    title: "The file changed on disk",
    action: {
      kind: "open-remote-preview",
      sessionId: "remote-edit",
      path: "/srv/app/report.txt",
      label: "Open in Tunara",
    },
  });
  expect(failure?.subtitle).toContain("/tmp/tunara-staged.txt");

  await vi.advanceTimersByTimeAsync(2_400);
  expect(writes).toBe(1);
});

test("interrupts external-editor sync when its SSH connection is lost", async () => {
  let resolveLocalRead: ((value: unknown) => void) | undefined;
  let writes = 0;
  mockIPC((command) => {
    if (command === "remote_edit_staging_path") return "/tmp/tunara-staged.txt";
    if (command === "ssh_fs_read_file") {
      return { kind: "text", content: "before", size: 6, fingerprint: "remote-v1" };
    }
    if (command === "ssh_fs_download") return 6;
    if (command === "open_in_editor") return null;
    if (command === "fs_read_file") {
      return new Promise((resolve) => { resolveLocalRead = resolve; });
    }
    if (command === "ssh_fs_write_text_file") {
      writes += 1;
      return { status: "saved", fingerprint: "remote-v2" };
    }
    throw new Error(`unexpected command: ${command}`);
  });

  await openRemoteInExternalEditor({
    sessionId: "remote-edit",
    binding,
    remotePath: "/srv/app/report.txt",
    editor: "vscode",
  });
  await vi.advanceTimersByTimeAsync(1_200);
  useSessionsStore.getState().handleConnectionEvent("remote-edit", { type: "transportLost" });

  const failure = useUIStore.getState().toasts.find((toast) => toast.variant === "error");
  expect(failure).toMatchObject({
    title: "Remote upload stopped",
    action: {
      kind: "open-remote-preview",
      sessionId: "remote-edit",
      path: "/srv/app/report.txt",
    },
  });
  expect(failure?.subtitle).toContain("/tmp/tunara-staged.txt");

  resolveLocalRead?.({ kind: "text", content: "after disconnect", size: 16, fingerprint: "local" });
  await vi.advanceTimersByTimeAsync(0);
  expect(writes).toBe(0);
});

test("explains that automatic upload stopped when its SSH session is closed", async () => {
  let writes = 0;
  mockIPC((command) => {
    if (command === "remote_edit_staging_path") return "/tmp/tunara-staged.txt";
    if (command === "ssh_fs_read_file") {
      return { kind: "text", content: "before", size: 6, fingerprint: "remote-v1" };
    }
    if (command === "ssh_fs_download") return 6;
    if (command === "open_in_editor") return null;
    if (command === "fs_read_file") {
      return { kind: "text", content: "after close", size: 11, fingerprint: "local" };
    }
    if (command === "ssh_fs_write_text_file") {
      writes += 1;
      return { status: "saved", fingerprint: "remote-v2" };
    }
    throw new Error(`unexpected command: ${command}`);
  });

  await openRemoteInExternalEditor({
    sessionId: "remote-edit",
    binding,
    remotePath: "/srv/app/report.txt",
    editor: "vscode",
  });
  useSessionsStore.getState().removeSession("remote-edit");

  const failure = useUIStore.getState().toasts.find((toast) => toast.variant === "error");
  expect(failure).toMatchObject({ title: "Remote upload stopped" });
  expect(failure?.subtitle).toContain("SSH session closed");
  expect(failure?.subtitle).toContain("/tmp/tunara-staged.txt");
  expect(failure).not.toHaveProperty("sessionId");
  expect(failure).not.toHaveProperty("action");

  await vi.advanceTimersByTimeAsync(2_400);
  expect(writes).toBe(0);
});
