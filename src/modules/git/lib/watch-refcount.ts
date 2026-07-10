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

export interface SerializedAsyncQueue {
  enqueue(key: string, operation: () => Promise<void>): Promise<void>;
  size(): number;
}

/**
 * Serialize lifecycle operations for each key while allowing different keys
 * to proceed independently. The queue tail always absorbs rejections so one
 * failed watch cannot strand later unwatch/retry operations; callers still
 * receive the original operation result for fallback handling.
 */
export function createSerializedAsyncQueue(): SerializedAsyncQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    enqueue(key: string, operation: () => Promise<void>) {
      if (!key) return Promise.resolve();
      const previous = (tails.get(key) ?? Promise.resolve()).catch(() => {});
      const run = previous.then(operation);
      const tail: Promise<void> = run.finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
      return tail;
    },
    size() {
      return tails.size;
    },
  };
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
