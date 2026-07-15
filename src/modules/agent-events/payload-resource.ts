import type { AgentEventHeaderV1, AgentEventPayload } from "./agent-event-bridge.ts";

export const TIMELINE_PAYLOAD_MAX_BYTES = 1024 * 1024;
export const TIMELINE_PAYLOAD_CACHE_MAX_BYTES = 6 * 1024 * 1024;
export const TIMELINE_PAYLOAD_CACHE_MAX_ENTRIES = 24;
export const TIMELINE_PAYLOAD_MAX_CONCURRENT = 4;
export const TIMELINE_PAYLOAD_MAX_QUEUED = 16;

export const TIMELINE_PAYLOAD_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
  "text/x-diff",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type TimelinePayloadContentType = typeof TIMELINE_PAYLOAD_CONTENT_TYPES[number];

export interface ValidatedTimelinePayload extends AgentEventPayload {
  contentType: TimelinePayloadContentType;
}

export type TimelinePayloadFaultCode =
  | "aborted"
  | "metadataInvalid"
  | "provenanceUnknown"
  | "requestBudgetExceeded"
  | "readFailed"
  | "eventMismatch"
  | "typeMismatch"
  | "sizeMismatch"
  | "hashMismatch";

export class TimelinePayloadFault extends Error {
  constructor(readonly code: TimelinePayloadFaultCode) {
    super(code);
    this.name = "TimelinePayloadFault";
  }
}

export interface TimelinePayloadMetrics {
  readsStarted: number;
  readsCompleted: number;
  readsAborted: number;
  staleResultsDiscarded: number;
  cacheHits: number;
  cacheEntries: number;
  cacheBytes: number;
  queued: number;
  active: number;
  peakActive: number;
}

interface CacheEntry {
  payload: ValidatedTimelinePayload;
  touched: number;
}

interface SharedRequest {
  key: string;
  header: AgentEventHeaderV1;
  controller: AbortController;
  waiters: number;
  started: boolean;
  resolve: (payload: ValidatedTimelinePayload) => void;
  reject: (reason: TimelinePayloadFault) => void;
  promise: Promise<ValidatedTimelinePayload>;
}

export type TimelinePayloadLoader = (eventId: string) => Promise<AgentEventPayload>;

function isSupportedContentType(value: string): value is TimelinePayloadContentType {
  return (TIMELINE_PAYLOAD_CONTENT_TYPES as readonly string[]).includes(value);
}

function payloadKey(header: AgentEventHeaderV1): string {
  return `${header.eventId}\u0000${header.payload?.sha256 ?? "missing"}`;
}

function validateHeader(header: AgentEventHeaderV1, provenanceKnown: boolean): void {
  if (!provenanceKnown) throw new TimelinePayloadFault("provenanceUnknown");
  const meta = header.payload;
  if (!meta
    || meta.state !== "available"
    || !isSupportedContentType(meta.contentType)
    || !Number.isSafeInteger(meta.byteLength)
    || meta.byteLength < 0
    || meta.byteLength > TIMELINE_PAYLOAD_MAX_BYTES
    || !/^[a-f0-9]{64}$/i.test(meta.sha256)) {
    throw new TimelinePayloadFault("metadataInvalid");
  }
}

function abortFault(): TimelinePayloadFault { return new TimelinePayloadFault("aborted"); }

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function validatePayload(header: AgentEventHeaderV1, payload: AgentEventPayload): Promise<ValidatedTimelinePayload> {
  const meta = header.payload!;
  if (payload.eventId !== header.eventId) throw new TimelinePayloadFault("eventMismatch");
  if (!isSupportedContentType(payload.contentType) || payload.contentType !== meta.contentType) throw new TimelinePayloadFault("typeMismatch");
  const actualBytes = new TextEncoder().encode(payload.body).byteLength;
  if (!Number.isSafeInteger(payload.byteLength)
    || payload.byteLength !== meta.byteLength
    || actualBytes !== meta.byteLength
    || actualBytes > TIMELINE_PAYLOAD_MAX_BYTES) {
    throw new TimelinePayloadFault("sizeMismatch");
  }
  if (!/^[a-f0-9]{64}$/i.test(payload.sha256)
    || payload.sha256.toLowerCase() !== meta.sha256.toLowerCase()
    || (await sha256Hex(payload.body)) !== meta.sha256.toLowerCase()) {
    throw new TimelinePayloadFault("hashMismatch");
  }
  return { ...payload, contentType: payload.contentType };
}

export class TimelinePayloadResourceManager {
  private cache = new Map<string, CacheEntry>();
  private requests = new Map<string, SharedRequest>();
  private queue: SharedRequest[] = [];
  private active = 0;
  private disposed = false;
  private clock = 0;
  private counters = {
    readsStarted: 0,
    readsCompleted: 0,
    readsAborted: 0,
    staleResultsDiscarded: 0,
    cacheHits: 0,
    peakActive: 0,
  };

  constructor(
    private readonly loader: TimelinePayloadLoader,
    private readonly limits = {
      maxBytes: TIMELINE_PAYLOAD_CACHE_MAX_BYTES,
      maxEntries: TIMELINE_PAYLOAD_CACHE_MAX_ENTRIES,
      maxConcurrent: TIMELINE_PAYLOAD_MAX_CONCURRENT,
      maxQueued: TIMELINE_PAYLOAD_MAX_QUEUED,
    },
  ) {}

  request(header: AgentEventHeaderV1, options: { signal: AbortSignal; provenanceKnown: boolean; priority?: boolean }): Promise<ValidatedTimelinePayload> {
    try {
      validateHeader(header, options.provenanceKnown);
    } catch (reason) {
      return Promise.reject(reason instanceof TimelinePayloadFault ? reason : new TimelinePayloadFault("metadataInvalid"));
    }
    if (this.disposed || options.signal.aborted) return Promise.reject(abortFault());
    const key = payloadKey(header);
    const cached = this.cache.get(key);
    if (cached) {
      cached.touched = ++this.clock;
      this.counters.cacheHits += 1;
      return Promise.resolve(cached.payload);
    }

    let shared = this.requests.get(key);
    if (shared?.controller.signal.aborted) {
      if (!shared.started) this.queue = this.queue.filter((candidate) => candidate !== shared);
      if (this.requests.get(key) === shared) this.requests.delete(key);
      shared = undefined;
    }
    if (!shared) {
      if (this.queue.length >= this.limits.maxQueued) {
        if (!options.priority) return Promise.reject(new TimelinePayloadFault("requestBudgetExceeded"));
        const displaced = this.queue.shift();
        if (displaced) {
          displaced.controller.abort();
          if (this.requests.get(displaced.key) === displaced) this.requests.delete(displaced.key);
          displaced.reject(new TimelinePayloadFault("requestBudgetExceeded"));
        }
      }
      let resolve!: (payload: ValidatedTimelinePayload) => void;
      let reject!: (reason: TimelinePayloadFault) => void;
      const promise = new Promise<ValidatedTimelinePayload>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
      shared = { key, header, controller: new AbortController(), waiters: 0, started: false, resolve, reject, promise };
      this.requests.set(key, shared);
      if (options.priority) this.queue.unshift(shared); else this.queue.push(shared);
      this.pump();
    }
    shared.waiters += 1;
    return this.waitFor(shared, options.signal);
  }

  snapshot(): TimelinePayloadMetrics {
    let cacheBytes = 0;
    for (const entry of this.cache.values()) cacheBytes += entry.payload.byteLength;
    return {
      ...this.counters,
      cacheEntries: this.cache.size,
      cacheBytes,
      queued: this.queue.length,
      active: this.active,
    };
  }

  clear(): void {
    this.cache.clear();
    for (const request of this.requests.values()) {
      request.controller.abort();
      request.reject(abortFault());
    }
    this.queue = [];
    this.requests.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  private waitFor(shared: SharedRequest, signal: AbortSignal): Promise<ValidatedTimelinePayload> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        shared.waiters = Math.max(0, shared.waiters - 1);
        if (shared.waiters === 0 && this.requests.get(shared.key) === shared) {
          shared.controller.abort();
          if (!shared.started) {
            this.queue = this.queue.filter((candidate) => candidate !== shared);
            this.requests.delete(shared.key);
            shared.reject(abortFault());
          }
        }
      };
      const onAbort = () => { release(); reject(abortFault()); };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then((payload) => { if (!settled) { release(); resolve(payload); } }, (reason) => { if (!settled) { release(); reject(reason); } });
      if (signal.aborted) onAbort();
    });
  }

  private pump(): void {
    while (!this.disposed && this.active < this.limits.maxConcurrent && this.queue.length > 0) {
      const shared = this.queue.shift()!;
      if (shared.controller.signal.aborted) {
        this.requests.delete(shared.key);
        shared.reject(abortFault());
        continue;
      }
      shared.started = true;
      this.active += 1;
      this.counters.readsStarted += 1;
      this.counters.peakActive = Math.max(this.counters.peakActive, this.active);
      void this.run(shared);
    }
  }

  private async run(shared: SharedRequest): Promise<void> {
    try {
      let raw: AgentEventPayload;
      try {
        raw = await this.loader(shared.header.eventId);
      } catch {
        throw new TimelinePayloadFault("readFailed");
      }
      const payload = await validatePayload(shared.header, raw);
      if (this.disposed || shared.controller.signal.aborted || this.requests.get(shared.key) !== shared) {
        this.counters.staleResultsDiscarded += 1;
        throw abortFault();
      }
      this.cache.set(shared.key, { payload, touched: ++this.clock });
      this.evict();
      this.counters.readsCompleted += 1;
      shared.resolve(payload);
    } catch (reason) {
      const fault = reason instanceof TimelinePayloadFault ? reason : new TimelinePayloadFault("readFailed");
      if (fault.code === "aborted") this.counters.readsAborted += 1;
      shared.reject(fault);
    } finally {
      if (this.requests.get(shared.key) === shared) this.requests.delete(shared.key);
      this.active = Math.max(0, this.active - 1);
      this.pump();
    }
  }

  private evict(): void {
    const bytes = () => [...this.cache.values()].reduce((total, entry) => total + entry.payload.byteLength, 0);
    while (this.cache.size > this.limits.maxEntries || bytes() > this.limits.maxBytes) {
      let oldestKey: string | null = null;
      let oldestTouched = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.cache) {
        if (entry.touched < oldestTouched) { oldestKey = key; oldestTouched = entry.touched; }
      }
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }
}
