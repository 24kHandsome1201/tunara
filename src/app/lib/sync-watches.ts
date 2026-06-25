export interface SyncWatchesResult {
  toAcquire: string[];
  toRelease: string[];
  next: Set<string>;
}

export function diffWatchedDirs(
  prev: ReadonlySet<string>,
  desired: Iterable<string>,
): SyncWatchesResult {
  const next = new Set<string>();
  for (const dir of desired) if (dir) next.add(dir);

  const toAcquire: string[] = [];
  const toRelease: string[] = [];
  for (const dir of next) if (!prev.has(dir)) toAcquire.push(dir);
  for (const dir of prev) if (!next.has(dir)) toRelease.push(dir);

  return { toAcquire, toRelease, next };
}
