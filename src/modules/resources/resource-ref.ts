import type { Session } from "@/ui/types";
import { openInEditor } from "@/modules/editor/open";
import { requestDirtyDraftFileAction } from "@/modules/editor/dirty-draft-guard";
import { t } from "@/modules/i18n";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { nextReaderJumpRequestId, readerRefIdentity, type ReaderDiffRef } from "@/modules/session/reader-state";
import { fsReadDir, fsResolveDir } from "@/modules/fs/fs-bridge";
import { sshHome, sshReadDir } from "@/modules/ssh/remote-fs-bridge";
import { resolveTerminalFileLinkPath } from "@/modules/terminal/lib/terminal-file-link-parser";

export type ResourceRef = {
  transport: "local" | "ssh";
  logicalSessionId: string;
  binding?: SessionBindingV1;
  path: string;
  line?: number;
  column?: number;
  diff?: ReaderDiffRef;
  /** Set by openResource for a line target; see ReaderFileRef.jumpRequestId. */
  jumpRequestId?: number;
};

export function resourceRefForSession(session: Session, path: string, line?: number, column?: number): ResourceRef {
  return {
    transport: session.remote ? "ssh" : "local",
    logicalSessionId: session.id,
    ...(session.remote && session.ptyId !== undefined && session.transportGeneration
      ? { binding: { logicalSessionId: session.id, physicalPtyId: session.ptyId, transportGeneration: session.transportGeneration } }
      : {}),
    path,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/** Opens a path only in the transport which produced it. Remote resources can
 * never cross the local editor IPC boundary or fall back to it. */
export async function openResource(ref: ResourceRef, disposition: "editor" | "preview" | "directory" = "editor"): Promise<void> {
  const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === ref.logicalSessionId);
  if (!session || (session.remote ? "ssh" : "local") !== ref.transport) throw new Error("stale resource owner");
  if (ref.transport === "local" && disposition === "editor") {
    await openInEditor(useUIStore.getState().externalEditor, ref.path, ref.line, ref.column);
    return;
  }
  if (ref.transport === "ssh" && (!ref.binding
    || ref.binding.logicalSessionId !== ref.logicalSessionId
    || session.ptyId !== ref.binding.physicalPtyId
    || session.transportGeneration !== ref.binding.transportGeneration)) {
    throw new Error("stale SSH resource binding");
  }
  if (disposition === "directory") {
    let path = ref.path;
    if (ref.transport === "ssh") {
      if (session.connection?.phase !== "ready") throw new Error("SSH session is not ready");
      if (path === "~" || path.startsWith("~/")) {
        const home = await sshHome(ref.binding!.physicalPtyId);
        path = path === "~" ? home : resolveTerminalFileLinkPath(`./${path.slice(2)}`, home);
      }
      await sshReadDir(ref.binding!.physicalPtyId, path);
    } else {
      path = await fsResolveDir(path);
      await fsReadDir(path);
    }
    // Directory checks are asynchronous: never navigate a replacement SSH
    // transport or resurrect a session closed while the request was pending.
    const current = useSessionsStore.getState().sessions.find((candidate) => candidate.id === ref.logicalSessionId);
    if (!current || (current.remote ? "ssh" : "local") !== ref.transport
      || (ref.transport === "ssh" && (current.ptyId !== ref.binding!.physicalPtyId
        || current.transportGeneration !== ref.binding!.transportGeneration || current.connection?.phase !== "ready"))) {
      throw new Error("stale directory resource");
    }
    useSessionsStore.getState().setActive(ref.logicalSessionId);
    useUIStore.setState((state) => ({
      panelVisible: true,
      inspectorTab: "files",
      explorerPaths: { ...state.explorerPaths, [ref.logicalSessionId]: path },
    }));
    return;
  }
  useSessionsStore.getState().setActive(ref.logicalSessionId);
  // Each open is its own navigation request, even for an identical hit.
  const jumpRequestId = ref.line !== undefined ? nextReaderJumpRequestId() : undefined;
  const apply = () => {
    const opened = useUIStore.getState().openReader({
      sessionId: ref.logicalSessionId,
      filePath: ref.path,
      fileName: ref.path.split("/").filter(Boolean).pop() ?? ref.path,
      line: ref.line,
      column: ref.column,
      diff: ref.diff,
      jumpRequestId,
    });
    if (!opened) {
      useUIStore.getState().addToast({
        sessionId: ref.logicalSessionId,
        title: t("reader.split_full"),
        subtitle: "",
        variant: "warning",
      });
    }
  };
  const current = useUIStore.getState().readers[ref.logicalSessionId]?.current;
  const nextIdentity = readerRefIdentity({ filePath: ref.path, fileName: "", diff: ref.diff });
  if (current && readerRefIdentity(current) !== nextIdentity) {
    if (requestDirtyDraftFileAction(ref.logicalSessionId, current.filePath, apply)) apply();
    return;
  }
  apply();
}
