import { useEffect, useRef, useState } from "react";

import {
  gitAheadBehind,
  gitStatus,
  gitWorkspaceContext,
  cancelRemoteGitSnapshot,
  sshRemoteGitSnapshotV1,
  type RemoteState,
  type StatusResult,
  type WorkspaceContext,
} from "@/modules/git/git-bridge";
import { deriveRemoteGitState, forceForNonce, snapshotMatches } from "@/modules/git/remote-git-state";
import { normalizeLocalRepoPath } from "@/modules/git/lib/path-normalize";
import { withCurrentDirtyFiles } from "@/modules/git/workspace-context";
import { useSessionsStore } from "@/state/sessions";

interface SessionGitContextInput {
  activeId?: string;
  activeDir?: string;
  activePtyId?: number;
  activeIsRemote: boolean;
  activeRemoteKey?: string;
  activeTransportGeneration?: string;
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
  activeTransportGeneration,
  nonce,
}: SessionGitContextInput): RemoteState | null {
  const [remoteState, setRemoteState] = useState<RemoteState | null>(null);
  const generationRef = useRef(0);
  const previousNonceRef = useRef(nonce);

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
    const generation = ++generationRef.current;
    const requestId = `remote-git-${activeId}-${generation}`;
    const existing = useSessionsStore.getState().sessions.find((session) => session.id === activeId);
    setRemoteState(existing?.gitRemoteState ?? null);
    useSessionsStore.getState().updateSession(activeId, { workspaceState: "loading" });

    const load = async () => {
      if (activeIsRemote) {
        if (!activeTransportGeneration) {
          useSessionsStore.getState().updateSession(activeId, { workspaceState: existing?.workspace ? "ready" : "unavailable" });
          return;
        }
        const binding = { logicalSessionId: activeId, physicalPtyId: activePtyId!, transportGeneration: activeTransportGeneration };
        const force = forceForNonce(previousNonceRef.current, nonce);
        previousNonceRef.current = nonce;
        const snapshot = await sshRemoteGitSnapshotV1({ requestId, generation, binding, cwd: activeDir ?? "", repositoryKey: activeRemoteKey ?? "remote", force });
        if (cancelled || !snapshotMatches(snapshot, requestId, generation, binding)) return;
        const gitState = deriveRemoteGitState(snapshot);
        setRemoteState(snapshot.repo?.upstream ?? null);
        const previous = useSessionsStore.getState().sessions.find((session) => session.id === activeId);
        const resolvedWorkspace = snapshot.repo?.workspace ? withCurrentDirtyFiles(snapshot.repo.workspace, snapshot.repo.status) : undefined;
        useSessionsStore.getState().updateSession(activeId, {
          gitState,
          gitFreshness: snapshot.freshness,
          gitError: snapshot.error,
          gitRemoteState: snapshot.repo?.upstream,
          branch: snapshot.repo?.status.branch ?? (gitState === "notGit" ? "" : previous?.branch ?? ""),
          changes: snapshot.repo ? { files: snapshot.repo.status.files } : (gitState === "notGit" ? undefined : previous?.changes),
          workspace: resolvedWorkspace ?? (gitState === "notGit" ? undefined : previous?.workspace),
          workspaceState: resolvedWorkspace ? "ready" : gitState === "notGit" ? "notGit" : "unavailable",
        });
        return;
      }
      const requests = [
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
      if (activeIsRemote) void cancelRemoteGitSnapshot(requestId);
    };
  }, [activeDir, activeId, activePtyId, activeIsRemote, activeRemoteKey, activeTransportGeneration, nonce]);

  return remoteState;
}
