import { invoke } from "@tauri-apps/api/core";
import { fsReadFile } from "@/modules/fs/fs-bridge";
import { sshDownload, sshReadFile, sshWriteTextFile } from "@/modules/ssh/remote-fs-bridge";
import { openInEditorWithToast } from "@/ui/lib/open-in-editor";
import { useUIStore } from "@/state/ui";
import { t } from "@/modules/i18n";

const watchers = new Map<string, ReturnType<typeof setInterval>>();

export async function remoteEditStagingPath(sessionId: string, remotePath: string): Promise<string> {
  return invoke<string>("remote_edit_staging_path", { sessionId, remotePath });
}

function watcherKey(sessionId: string, remotePath: string): string {
  return `${sessionId}\0${remotePath}`;
}

export function stopRemoteExternalEdit(sessionId: string, remotePath?: string): void {
  if (remotePath) {
    const key = watcherKey(sessionId, remotePath);
    const timer = watchers.get(key);
    if (timer) clearInterval(timer);
    watchers.delete(key);
    return;
  }
  for (const [key, timer] of watchers) {
    if (key.startsWith(`${sessionId}\0`)) {
      clearInterval(timer);
      watchers.delete(key);
    }
  }
}

export async function openRemoteInExternalEditor(options: {
  sessionId: string;
  remotePtyId: number;
  remotePath: string;
  editor: string;
}): Promise<void> {
  const { sessionId, remotePtyId, remotePath, editor } = options;
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
  await openInEditorWithToast(editor, localPath, { sessionId });
  const key = watcherKey(sessionId, remotePath);
  const existing = watchers.get(key);
  if (existing) clearInterval(existing);
  let fingerprint = remote.fingerprint;
  let lastContent = remote.content;
  const timer = setInterval(() => {
    void fsReadFile(localPath).then(async (result) => {
      if (result.kind !== "text" || result.content === lastContent) return;
      const written = await sshWriteTextFile(remotePtyId, remotePath, result.content, fingerprint);
      if (written.status === "saved") {
        fingerprint = written.fingerprint;
        lastContent = result.content;
      }
    }).catch(() => {});
  }, 1_200);
  watchers.set(key, timer);
  useUIStore.getState().addToast({
    sessionId,
    title: t("preview.editor.external_remote"),
    subtitle: t("preview.editor.external_remote_hint"),
    variant: "success",
  });
}
