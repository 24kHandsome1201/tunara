import { useEffect, useState } from "react";

import {
  gitAheadBehind,
  gitStatus,
  gitWorkspaceContext,
  cancelGitRequest,
  sshGitAheadBehind,
  sshGitStatus,
  sshGitWorkspaceContext,
  type RemoteState,
  type StatusResult,
  type WorkspaceContext,
} from "@/modules/git/git-bridge";
import { normalizeLocalRepoPath } from "@/modules/git/lib/path-normalize";
import { withCurrentDirtyFiles } from "@/modules/git/workspace-context";
import { useSessionsStore } from "@/state/sessions";

interface SessionGitContextInput {
  activeId?: string;
  activeDir?: string;
  activePtyId?: number;
  activeIsRemote: boolean;
  activeRemoteKey?: string;
  nonce: number;
}

function settledValue<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function commitGitContext(
  sessionId: string,
  status: StatusResult | undefined,
  workspace: WorkspaceContext | undefined,
) {
  const resolvedWorkspace = status && workspace
    ? withCurrentDirtyFiles(workspace, status)
    : workspace;
  useSessionsStore.getState().updateSession(sessionId, {
    branch: status?.branch ?? "",
    gitState: status ? "repo" : "notGit",
    changes: status ? { files: status.files } : undefined,
    workspace: resolvedWorkspace,
    workspaceState: resolvedWorkspace ? "ready" : status ? "unavailable" : "notGit",
  });
}

/**
 * Resolve the active session's Review state and repository/worktree context as
 * one generation. Promise.allSettled prevents one unavailable capability from
 * hiding the others, while the effect cancellation drops stale cwd/session
 * responses without touching the PTY.
 */
export function useSessionGitContext({
  activeId,
  activeDir,
  activePtyId,
  activeIsRemote,
  activeRemoteKey,
  nonce,
}: SessionGitContextInput): RemoteState | null {
  const [remoteState, setRemoteState] = useState<RemoteState | null>(null);

  useEffect(() => {
    if (!activeId) {
      setRemoteState(null);
      return;
    }

    if (activeIsRemote && activePtyId === undefined) {
      setRemoteState(null);
      useSessionsStore.getState().updateSession(activeId, {
        branch: "",
        gitState: "notGit",
        changes: undefined,
        workspace: undefined,
        workspaceState: "loading",
      });
      return;
    }

    const repoPath = activeIsRemote ? undefined : normalizeLocalRepoPath(activeDir);
    if (!activeIsRemote && !repoPath) {
      setRemoteState(null);
      useSessionsStore.getState().updateSession(activeId, {
        branch: "",
        gitState: "notGit",
        changes: undefined,
        workspace: undefined,
        workspaceState: "notGit",
      });
      return;
    }

    let cancelled = false;
    const requestId = `workspace-${activeId}-${Date.now()}-${nonce}`;
    setRemoteState(null);
    useSessionsStore.getState().updateSession(activeId, { workspaceState: "loading" });

    const load = async () => {
      const requests = activeIsRemote
        ? [
            sshGitAheadBehind(activePtyId!, activeDir ?? ""),
            sshGitStatus(activePtyId!, activeDir ?? ""),
            sshGitWorkspaceContext(activePtyId!, activeDir ?? "", activeRemoteKey ?? "remote", requestId),
          ] as const
        : [
            gitAheadBehind(repoPath!),
            gitStatus(repoPath!),
            gitWorkspaceContext(repoPath!),
          ] as const;
      const [aheadResult, statusResult, workspaceResult] = await Promise.allSettled(requests);
      if (cancelled) return;
      setRemoteState(settledValue(aheadResult) ?? null);
      commitGitContext(
        activeId,
        settledValue(statusResult),
        settledValue(workspaceResult),
      );
    };

    void load();
    return () => {
      cancelled = true;
      if (activeIsRemote) void cancelGitRequest(requestId);
    };
  }, [activeDir, activeId, activePtyId, activeIsRemote, activeRemoteKey, nonce]);

  return remoteState;
}
