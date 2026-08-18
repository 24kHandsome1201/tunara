import { normalizeLocalRepoPath } from "../../modules/git/lib/path-normalize.ts";

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
    const dir = normalizeLocalRepoPath(session.dir);
    if (dir) dirs.push(dir);
  }
  return dirs;
}

/** Stable local-directory-set projection, independent of session runtime state. */
export function gitWatchDirProjection(sessions: Iterable<GitWatchSessionLike>): string[] {
  return [...new Set(gitWatchDirsForSessions(sessions))].sort();
}

export function sameGitWatchDirProjection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((dir, index) => dir === right[index]);
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
