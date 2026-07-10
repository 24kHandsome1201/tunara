export type RemoteOperationKind = "find" | "grep";

export function remoteOperationCacheKey(
  kind: RemoteOperationKind,
  ptyId: number,
  root: string,
  query: string,
  limit: number,
): string {
  // A JSON tuple avoids delimiter collisions when a valid path or query
  // contains `|`, and keeps response-shaping options in the cache identity.
  return JSON.stringify([kind, ptyId, root, query, limit]);
}

interface CacheEntry<T> {
  ptyId: number;
  value: T;
}

/** Tiny session-aware LRU used by expensive remote find/grep calls. */
export class RemoteOperationCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly sessionGenerations = new Map<number, number>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("remote operation cache size must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached.value;
  }

  set(key: string, ptyId: number, value: T): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { ptyId, value });
  }

  sessionGeneration(ptyId: number): number {
    return this.sessionGenerations.get(ptyId) ?? 0;
  }

  /** Cache a response only if no refresh invalidated its session in flight. */
  setIfCurrent(key: string, ptyId: number, generation: number, value: T): boolean {
    if (this.sessionGeneration(ptyId) !== generation) return false;
    this.set(key, ptyId, value);
    return true;
  }

  invalidateSession(ptyId: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.ptyId === ptyId) this.entries.delete(key);
    }
    this.sessionGenerations.set(ptyId, this.sessionGeneration(ptyId) + 1);
  }

  get size(): number {
    return this.entries.size;
  }
}
