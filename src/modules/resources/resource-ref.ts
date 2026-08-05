import type { Session } from "@/ui/types";
import { openInEditor } from "@/modules/editor/open";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

export type ResourceRef = {
  transport: "local" | "ssh";
  logicalSessionId: string;
  binding?: SessionBindingV1;
  path: string;
  line?: number;
  column?: number;
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
export async function openResource(ref: ResourceRef, localDisposition: "editor" | "preview" = "editor"): Promise<void> {
  const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === ref.logicalSessionId);
  if (!session || (session.remote ? "ssh" : "local") !== ref.transport) throw new Error("stale resource owner");
  if (ref.transport === "local" && localDisposition === "editor") {
    await openInEditor(useUIStore.getState().externalEditor, ref.path, ref.line, ref.column);
    return;
  }
  if (ref.transport === "ssh" && (!ref.binding
    || ref.binding.logicalSessionId !== ref.logicalSessionId
    || session.ptyId !== ref.binding.physicalPtyId
    || session.transportGeneration !== ref.binding.transportGeneration)) {
    throw new Error("stale SSH resource binding");
  }
  useSessionsStore.getState().setActive(ref.logicalSessionId);
  useUIStore.getState().openFileTab({
    sessionId: ref.logicalSessionId,
    filePath: ref.path,
    fileName: ref.path.split("/").filter(Boolean).pop() ?? ref.path,
    line: ref.line,
    column: ref.column,
  });
}
