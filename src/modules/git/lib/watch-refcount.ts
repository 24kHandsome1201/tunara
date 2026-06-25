export interface WatchRefCountHandlers {
  onFirstAcquire: (key: string) => void;
  onLastRelease: (key: string) => void;
}

export interface WatchRefCount {
  acquire(key: string): void;
  release(key: string): void;
  peek(key: string): number;
  size(): number;
}

export function createWatchRefCount({
  onFirstAcquire,
  onLastRelease,
}: WatchRefCountHandlers): WatchRefCount {
  const counts = new Map<string, number>();

  return {
    acquire(key: string) {
      if (!key) return;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      if (next === 1) onFirstAcquire(key);
    },
    release(key: string) {
      if (!key) return;
      const current = counts.get(key) ?? 0;
      if (current <= 1) {
        counts.delete(key);
        if (current === 1) onLastRelease(key);
      } else {
        counts.set(key, current - 1);
      }
    },
    peek(key: string) {
      return counts.get(key) ?? 0;
    },
    size() {
      return counts.size;
    },
  };
}
