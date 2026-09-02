import { invoke } from "@tauri-apps/api/core";
import { fsReadFile } from "@/modules/fs/fs-bridge";
import { sshDownload, sshReadFile, sshWriteTextFile } from "@/modules/ssh/remote-fs-bridge";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { openInEditorWithToast } from "@/ui/lib/open-in-editor";
import { useUIStore } from "@/state/ui";
import { t } from "@/modules/i18n";

type RemoteEditWatcher = {
  timer: ReturnType<typeof setInterval>;
  localPath: string;
  remotePath: string;
};

const watchers = new Map<string, RemoteEditWatcher>();

export async function remoteEditStagingPath(sessionId: string, remotePath: string): Promise<string> {
  return invoke<string>("remote_edit_staging_path", { sessionId, remotePath });
}

function watcherKey(sessionId: string, remotePath: string): string {
  return `${sessionId}\0${remotePath}`;
}

export function stopRemoteExternalEdit(sessionId: string, remotePath?: string): void {
  if (remotePath) {
    const key = watcherKey(sessionId, remotePath);
    const watcher = watchers.get(key);
    if (watcher) clearInterval(watcher.timer);
    watchers.delete(key);
    return;
  }
  for (const [key, watcher] of watchers) {
    if (key.startsWith(`${sessionId}\0`)) {
      clearInterval(watcher.timer);
      watchers.delete(key);
    }
  }
}

function finishRemoteExternalEdits(sessionId: string, sessionClosed: boolean): void {
  for (const [key, watcher] of watchers) {
    if (!key.startsWith(`${sessionId}\0`)) continue;
    clearInterval(watcher.timer);
    watchers.delete(key);
    if (sessionClosed) {
      useUIStore.getState().addToast({
        title: t("preview.editor.external_remote_sync_failed"),
        subtitle: t("preview.editor.external_remote_session_closed_body", { path: watcher.localPath }),
        variant: "error",
      });
      continue;
    }
    useUIStore.getState().addToast({
      sessionId,
      title: t("preview.editor.external_remote_sync_failed"),
      subtitle: t("preview.editor.external_remote_sync_failed_body", { path: watcher.localPath }),
      variant: "error",
      action: {
        kind: "open-remote-preview",
        sessionId,
        path: watcher.remotePath,
        label: t("explorer.open_in_tunara"),
      },
    });
  }
}

export function interruptRemoteExternalEdit(sessionId: string): void {
  finishRemoteExternalEdits(sessionId, false);
}

export function closeRemoteExternalEdits(sessionId: string): void {
  finishRemoteExternalEdits(sessionId, true);
}

export async function openRemoteInExternalEditor(options: {
  sessionId: string;
  binding: SessionBindingV1;
  remotePath: string;
  editor: string;
}): Promise<void> {
  const { sessionId, binding, remotePath, editor } = options;
  const remotePtyId = binding.physicalPtyId;
  const localPath = await remoteEditStagingPath(sessionId, remotePath);
  const remote = await sshReadFile(remotePtyId, remotePath);
  if (remote.kind !== "text" || !remote.fingerprint) {
    useUIStore.getState().addToast({
      sessionId,
      title: t("preview.editor.external_remote"),
      subtitle: t("preview.editor.error_unsupported"),
      variant: "error",
    });
    return;
  }
  await sshDownload(remotePtyId, remotePath, localPath);
  const opened = await openInEditorWithToast(editor, localPath, { sessionId });
  if (!opened) return;
  const key = watcherKey(sessionId, remotePath);
  const existing = watchers.get(key);
  if (existing) clearInterval(existing.timer);
  let fingerprint = remote.fingerprint;
  let lastContent = remote.content;
  let syncing = false;
  const timer = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void fsReadFile(localPath).then(async (result) => {
      if (result.kind !== "text") {
        stopWithError(
          t("preview.editor.external_remote_sync_failed"),
          t("preview.editor.external_remote_sync_failed_body", { path: localPath }),
        );
        return;
      }
      if (result.content === lastContent) return;
      if (watchers.get(key)?.timer !== timer) return;
      const written = await sshWriteTextFile(binding, remotePath, result.content, fingerprint);
      if (watchers.get(key)?.timer !== timer) return;
      if (written.status === "saved") {
        fingerprint = written.fingerprint;
        lastContent = result.content;
        return;
      }
      stopWithError(
        t("preview.editor.conflict_title"),
        t("preview.editor.external_remote_conflict_body", { path: localPath }),
      );
    }).catch(() => {
      stopWithError(
        t("preview.editor.external_remote_sync_failed"),
        t("preview.editor.external_remote_sync_failed_body", { path: localPath }),
      );
    }).finally(() => {
      syncing = false;
    });
  }, 1_200);
  function stopWithError(title: string, subtitle: string) {
    const activeWatcher = watchers.get(key);
    if (activeWatcher?.timer !== timer) return;
    clearInterval(activeWatcher.timer);
    watchers.delete(key);
    useUIStore.getState().addToast({
      sessionId,
      title,
      subtitle,
      variant: "error",
      action: {
        kind: "open-remote-preview",
        sessionId,
        path: remotePath,
        label: t("explorer.open_in_tunara"),
      },
    });
  }
  watchers.set(key, { timer, localPath, remotePath });
}
