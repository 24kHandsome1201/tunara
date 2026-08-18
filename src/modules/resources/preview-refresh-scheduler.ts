export const PREVIEW_REFRESH_INTERVAL_MS = 2_500;
const FORCE_REVERIFY_MS = 60_000;
const BACKOFF_MS = [5_000, 10_000, 20_000, 30_000] as const;

export interface PreviewRefreshContext { force: boolean }
export interface PreviewRefreshSubscription<T> {
  key: string;
  eligible: () => boolean;
  read: (context: PreviewRefreshContext) => Promise<T>;
  commit: (value: T) => void;
}

interface Subscriber<T = unknown> extends PreviewRefreshSubscription<T> { generation: number }
interface Entry {
  subscribers: Set<Subscriber>;
  inFlight: boolean;
  failures: number;
  dueAt: number;
  lastForcedAt: number;
}

export interface PreviewRefreshSchedulerEnvironment {
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => number;
  clearTimeout?: (timer: number) => void;
  visibility?: { visibilityState: string; addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void };
}

/** One process-wide timer and one request per resource/view key. */
export class PreviewRefreshScheduler {
  private readonly entries = new Map<string, Entry>();
  private timer: number | null = null;
  private generation = 0;
  private visible: boolean;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => number;
  private readonly clearTimerImpl: (timer: number) => void;
  private readonly visibility?: PreviewRefreshSchedulerEnvironment["visibility"];

  constructor(environment: PreviewRefreshSchedulerEnvironment = {}) {
    this.now = environment.now ?? (() => Date.now());
    this.setTimer = environment.setTimeout ?? ((callback, delay) => window.setTimeout(callback, delay));
    this.clearTimerImpl = environment.clearTimeout ?? ((timer) => window.clearTimeout(timer));
    this.visibility = environment.visibility ?? (typeof document === "undefined" ? undefined : document);
    this.visible = !this.visibility || this.visibility.visibilityState === "visible";
    this.visibility?.addEventListener("visibilitychange", this.onVisibility);
  }

  subscribe<T>(subscription: PreviewRefreshSubscription<T>): () => void {
    const subscriber: Subscriber<T> = { ...subscription, generation: ++this.generation };
    const entry = this.entries.get(subscription.key) ?? {
      subscribers: new Set(), inFlight: false, failures: 0, dueAt: this.now(), lastForcedAt: 0,
    };
    entry.subscribers.add(subscriber as Subscriber);
    this.entries.set(subscription.key, entry);
    this.schedule(0);
    return () => {
      subscriber.generation = ++this.generation;
      entry.subscribers.delete(subscriber as Subscriber);
      if (entry.subscribers.size === 0 && !entry.inFlight) this.entries.delete(subscription.key);
      this.schedule();
    };
  }

  /** Call after active/dirty/connectivity eligibility changes. */
  poke(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (!entry.inFlight && [...entry.subscribers].some((subscriber) => subscriber.eligible())) {
        entry.dueAt = Math.min(entry.dueAt, now);
      }
    }
    this.schedule(0);
  }

  /** Release event listeners/timers and invalidate pending commits (primarily test isolation). */
  dispose(): void {
    this.visibility?.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimer();
    for (const entry of this.entries.values()) {
      for (const subscriber of entry.subscribers) subscriber.generation = ++this.generation;
      entry.subscribers.clear();
    }
    this.entries.clear();
  }

  private readonly onVisibility = () => {
    this.visible = this.visibility?.visibilityState === "visible";
    if (this.visible) this.poke();
    else this.clearTimer();
  };

  private clearTimer(): void {
    if (this.timer !== null) this.clearTimerImpl(this.timer);
    this.timer = null;
  }

  private schedule(delay?: number): void {
    this.clearTimer();
    if (!this.visible || this.entries.size === 0) return;
    const now = this.now();
    const next = delay ?? Math.max(0, Math.min(...[...this.entries.values()]
      .filter((entry) => !entry.inFlight && [...entry.subscribers].some((subscriber) => subscriber.eligible()))
      .map((entry) => entry.dueAt - now)));
    if (!Number.isFinite(next)) return;
    this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, next);
  }

  private async tick(): Promise<void> {
    const now = this.now();
    const jobs: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      const subscribers = [...entry.subscribers].filter((subscriber) => subscriber.eligible());
      if (entry.inFlight || entry.dueAt > now || subscribers.length === 0) continue;
      entry.inFlight = true;
      const leader = subscribers[0];
      const force = entry.lastForcedAt === 0 || now - entry.lastForcedAt >= FORCE_REVERIFY_MS;
      if (force) entry.lastForcedAt = now;
      const generations = new Map(subscribers.map((subscriber) => [subscriber, subscriber.generation]));
      jobs.push(leader.read({ force }).then((value) => {
        entry.failures = 0;
        for (const subscriber of subscribers) {
          if (entry.subscribers.has(subscriber) && subscriber.generation === generations.get(subscriber) && subscriber.eligible()) {
            subscriber.commit(value);
          }
        }
        entry.dueAt = this.now() + PREVIEW_REFRESH_INTERVAL_MS;
      }).catch(() => {
        entry.failures += 1;
        entry.dueAt = this.now() + BACKOFF_MS[Math.min(entry.failures - 1, BACKOFF_MS.length - 1)];
      }).finally(() => {
        entry.inFlight = false;
        if (entry.subscribers.size === 0) this.entries.delete(key);
      }));
    }
    await Promise.all(jobs);
    this.schedule();
  }
}

export const previewRefreshScheduler = new PreviewRefreshScheduler();

export function previewRefreshKey(resource: { transport: "local" | "ssh"; logicalSessionId: string; binding?: { logicalSessionId: string; physicalPtyId: number; transportGeneration: string }; path: string }, view: string, budget = 0): string {
  const owner = resource.transport === "ssh" && resource.binding
    ? [resource.binding.logicalSessionId, resource.binding.physicalPtyId, resource.binding.transportGeneration]
    : ["local", resource.logicalSessionId];
  return JSON.stringify([resource.transport, ...owner, resource.path, view, budget]);
}
