import { useEffect } from "react";

import {
  cancelGitRequest,
  gitWorkspaceContext,
  sshGitWorkspaceContext,
  type WorkspaceContext,
} from "@/modules/git/git-bridge";
import {
  buildWorkspaceHydrationGroups,
  WORKSPACE_HYDRATION_CONCURRENCY,
  workspaceHydrationKey,
  workspaceHydrationSignature,
  type WorkspaceHydrationGroup,
} from "@/modules/git/workspace-hydration";
import { useSessionsStore } from "@/state/sessions";
import type { Session } from "./types";

interface HydrationResult {
  group: WorkspaceHydrationGroup;
  workspace?: WorkspaceContext;
}

/**
 * Hydrate repository/worktree identity for restored, non-active sessions.
 * Requests are deduplicated by transport + host + cwd and run with a small
 * concurrency budget. Active-session Review state remains owned by
 * useSessionGitContext.
 */
export function useWorkspaceHydration(sessions: readonly Session[], activeSessionId?: string) {
  const groups = buildWorkspaceHydrationGroups(sessions, activeSessionId);
  const signature = workspaceHydrationSignature(groups);

  useEffect(() => {
    if (groups.length === 0) return;
    let cancelled = false;
    let cursor = 0;
    const requestIds = new Set<string>();
    const results: HydrationResult[] = [];

    const hydrate = async (group: WorkspaceHydrationGroup): Promise<HydrationResult> => {
      try {
        if (group.transport === "local") {
          return { group, workspace: await gitWorkspaceContext(group.dir) };
        }
        const requestId = `hydrate-${group.sessionIds[0]}-${Date.now()}-${cursor}`;
        requestIds.add(requestId);
        try {
          const workspace = await sshGitWorkspaceContext(
            group.ptyId!,
            group.dir,
            group.repositoryKey!,
            requestId,
          );
          return { group, workspace };
        } finally {
          requestIds.delete(requestId);
        }
      } catch {
        return { group };
      }
    };

    const worker = async () => {
      while (!cancelled) {
        const index = cursor++;
        const group = groups[index];
        if (!group) return;
        results.push(await hydrate(group));
      }
    };

    const run = async () => {
      const workerCount = Math.min(WORKSPACE_HYDRATION_CONCURRENCY, groups.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      if (cancelled) return;
      const bySession = new Map<string, HydrationResult>();
      for (const result of results) {
        for (const sessionId of result.group.sessionIds) bySession.set(sessionId, result);
      }
      useSessionsStore.setState((state) => ({
        sessions: state.sessions.map((session) => {
          const result = bySession.get(session.id);
          if (!result || workspaceHydrationKey(session, activeSessionId) !== result.group.key) return session;
          return {
            ...session,
            workspace: result.workspace,
            workspaceState: result.workspace
              ? "ready"
              : result.group.transport === "ssh"
                ? "unavailable"
                : "notGit",
          };
        }),
      }));
    };

    void run();
    return () => {
      cancelled = true;
      for (const requestId of requestIds) void cancelGitRequest(requestId);
    };
    // `signature` is the stable, minimal dependency. Session heartbeats and
    // unrelated state updates do not restart hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
