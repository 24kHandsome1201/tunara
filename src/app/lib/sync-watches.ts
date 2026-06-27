import { normalizeRepoPath } from "../../modules/git/lib/path-normalize.ts";

export interface SyncWatchesResult {
  toAcquire: string[];
  toRelease: string[];
  next: Set<string>;
}

export interface GitWatchSessionLike {
  dir?: string;
  remote?: unknown;
}

export function gitWatchDirsForSessions(sessions: Iterable<GitWatchSessionLike>): string[] {
  const dirs: string[] = [];
  for (const session of sessions) {
    if (session.remote || !session.dir) continue;
    const dir = normalizeRepoPath(session.dir);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

export function diffWatchedDirs(
  prev: ReadonlySet<string>,
  desired: Iterable<string | null | undefined>,
): SyncWatchesResult {
  const next = new Set<string>();
  for (const dir of desired) if (dir) next.add(dir);

  const toAcquire: string[] = [];
  const toRelease: string[] = [];
  for (const dir of next) if (!prev.has(dir)) toAcquire.push(dir);
  for (const dir of prev) if (!next.has(dir)) toRelease.push(dir);

  return { toAcquire, toRelease, next };
}
