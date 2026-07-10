import { normalizeLocalRepoPath } from "./lib/path-normalize.ts";

export const WORKSPACE_HYDRATION_CONCURRENCY = 2;

export interface WorkspaceHydrationSession {
  id: string;
  dir: string;
  ptyId?: number;
  remote?: { host: string; port: number; user: string };
  workspaceState?: "unknown" | "loading" | "ready" | "notGit" | "unavailable";
}

export interface WorkspaceHydrationGroup {
  key: string;
  transport: "local" | "ssh";
  dir: string;
  sessionIds: string[];
  ptyId?: number;
  repositoryKey?: string;
}

export function workspaceHydrationKey(
  session: WorkspaceHydrationSession,
  activeSessionId?: string,
): string | undefined {
  if (session.id === activeSessionId) return undefined;
  if (["loading", "ready", "notGit"].includes(session.workspaceState ?? "unknown")) return undefined;

  if (session.remote) {
    if (session.ptyId === undefined || !session.dir.startsWith("/")) return undefined;
    const repositoryKey = `${session.remote.user}@${session.remote.host}:${session.remote.port}`;
    return `ssh:${repositoryKey}:${session.dir}`;
  }

  // A local transient error is retried when the session becomes active, not on
  // every unrelated store update. Remote unavailable entries may retry after
  // reconnect because their pty id participates in the group signature.
  if (session.workspaceState === "unavailable") return undefined;
  const dir = normalizeLocalRepoPath(session.dir);
  return dir ? `local:${dir}` : undefined;
}

export function buildWorkspaceHydrationGroups(
  sessions: readonly WorkspaceHydrationSession[],
  activeSessionId?: string,
): WorkspaceHydrationGroup[] {
  const groups = new Map<string, WorkspaceHydrationGroup>();
  for (const session of sessions) {
    const key = workspaceHydrationKey(session, activeSessionId);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.sessionIds.push(session.id);
      continue;
    }
    if (session.remote) {
      groups.set(key, {
        key,
        transport: "ssh",
        dir: session.dir,
        sessionIds: [session.id],
        ptyId: session.ptyId,
        repositoryKey: `${session.remote.user}@${session.remote.host}:${session.remote.port}`,
      });
    } else {
      groups.set(key, {
        key,
        transport: "local",
        dir: normalizeLocalRepoPath(session.dir)!,
        sessionIds: [session.id],
      });
    }
  }
  return [...groups.values()];
}

export function workspaceHydrationSignature(groups: readonly WorkspaceHydrationGroup[]): string {
  return groups
    .map((group) => `${group.key}:${group.ptyId ?? "local"}:${group.sessionIds.join(",")}`)
    .join("|");
}
