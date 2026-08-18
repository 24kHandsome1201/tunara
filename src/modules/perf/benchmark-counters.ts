/** Pure, non-reactive benchmark seam. Product code never subscribes to it. */
export interface FrontendPerfSnapshot {
  transferStoreWrites: number;
  treeStoreWrites: number;
  persistenceStoreWrites: number;
  renders: number;
  workspaceProjections: number;
  persistenceIpc: number;
  persistenceDebounceMerges: number;
  terminalBackstopFlushes: number;
  closeFlushes: number;
  gitWatchAcquires: number;
  gitWatchReleases: number;
}

export type FrontendPerfCounter = keyof FrontendPerfSnapshot;
const counters: FrontendPerfSnapshot = {
  transferStoreWrites: 0, treeStoreWrites: 0, persistenceStoreWrites: 0, renders: 0,
  workspaceProjections: 0, persistenceIpc: 0, persistenceDebounceMerges: 0,
  terminalBackstopFlushes: 0, closeFlushes: 0, gitWatchAcquires: 0, gitWatchReleases: 0,
};

export function recordFrontendPerf(counter: FrontendPerfCounter, amount = 1): void {
  counters[counter] += amount;
}

export function snapshotFrontendPerf(): FrontendPerfSnapshot { return { ...counters }; }
export function resetFrontendPerf(): void { for (const key of Object.keys(counters) as FrontendPerfCounter[]) counters[key] = 0; }
export function deltaFrontendPerf(after: FrontendPerfSnapshot, baseline: FrontendPerfSnapshot): FrontendPerfSnapshot {
  return Object.fromEntries((Object.keys(counters) as FrontendPerfCounter[]).map((key) => [key, Math.max(0, after[key] - baseline[key])])) as unknown as FrontendPerfSnapshot;
}

export interface PairedBenchmarkRecord<T> { baseline: T; after: T }
export function pairedBenchmarkRecord<T>(baseline: T, after: T): PairedBenchmarkRecord<T> { return { baseline, after }; }
