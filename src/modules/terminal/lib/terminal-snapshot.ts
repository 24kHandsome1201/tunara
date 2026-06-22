import type { PersistedTerminalSnapshot } from "@/state/persist";

const MAX_SERIALIZED_SIZE = 256 * 1024;
const MAX_SNAPSHOTS = 8;

const snapshots = new Map<string, PersistedTerminalSnapshot>();

function trimSnapshot(snapshot: PersistedTerminalSnapshot): PersistedTerminalSnapshot {
  if (snapshot.serialized.length <= MAX_SERIALIZED_SIZE) return snapshot;
  return {
    ...snapshot,
    serialized: snapshot.serialized.slice(-MAX_SERIALIZED_SIZE),
    truncated: true,
  };
}

export function updateTerminalSnapshot(sessionId: string, snapshot: PersistedTerminalSnapshot): void {
  snapshots.set(sessionId, trimSnapshot(snapshot));

  if (snapshots.size > MAX_SNAPSHOTS) {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, snap] of snapshots) {
      if (id === sessionId) continue;
      if (snap.capturedAt < oldestTime) {
        oldestTime = snap.capturedAt;
        oldestId = id;
      }
    }
    if (oldestId) snapshots.delete(oldestId);
  }
}

export function getTerminalSnapshot(sessionId: string): PersistedTerminalSnapshot | undefined {
  return snapshots.get(sessionId);
}

export function getAllTerminalSnapshots(): Record<string, PersistedTerminalSnapshot> {
  return Object.fromEntries(snapshots);
}

export function removeTerminalSnapshot(sessionId: string): void {
  snapshots.delete(sessionId);
}

export function restoreTerminalSnapshots(stored: Record<string, PersistedTerminalSnapshot>): void {
  snapshots.clear();
  for (const [id, snap] of Object.entries(stored)) {
    snapshots.set(id, trimSnapshot(snap));
    if (snapshots.size >= MAX_SNAPSHOTS) break;
  }
}
