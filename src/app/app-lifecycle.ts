import { requestActiveDirtyDraftAction } from "@/modules/editor/dirty-draft-guard";
import { flushUserConfig } from "@/state/ui";
import type { WorkspaceSnapshotSaveResult } from "@/state/persist";

type WorkspaceFlush = () => Promise<WorkspaceSnapshotSaveResult>;

let workspaceFlush: WorkspaceFlush | null = null;

/** Register the workspace writer owned by useInit without duplicating its queue. */
export function registerWorkspaceFlush(flush: WorkspaceFlush): () => void {
  workspaceFlush = flush;
  return () => {
    if (workspaceFlush === flush) workspaceFlush = null;
  };
}

/**
 * Guard a process restart behind every dirty editor and both durable stores.
 * Returning false means an editor owns the pending confirmation; its eventual
 * discard re-enters this same flush path before relaunching.
 */
export function requestSafeAppRelaunch(
  relaunch: () => Promise<void>,
  callbacks: {
    onStarting: () => void;
    onFailure: (error: unknown) => void;
  },
): boolean {
  const finish = async () => {
    callbacks.onStarting();
    try {
      if (!workspaceFlush) throw new Error("workspace persistence is not ready");
      const [workspaceResult, configSaved] = await Promise.all([
        workspaceFlush(),
        flushUserConfig(),
      ]);
      if (workspaceResult !== "saved" || !configSaved) {
        throw new Error("application state could not be persisted before restart");
      }
      await relaunch();
    } catch (error) {
      callbacks.onFailure(error);
    }
  };

  if (!requestActiveDirtyDraftAction(() => { void finish(); }, "restart")) return false;
  void finish();
  return true;
}

/** Test-only reset for the module-level persistence registration. */
export function resetAppLifecycleForTests(): void {
  workspaceFlush = null;
}
