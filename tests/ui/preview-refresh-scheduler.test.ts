import { describe, expect, it, vi } from "vitest";
import { PreviewRefreshScheduler, previewRefreshKey } from "@/modules/resources/preview-refresh-scheduler";

function harness(visible = true) {
  vi.useFakeTimers();
  let state = visible ? "visible" : "hidden";
  const listeners = new Set<() => void>();
  const scheduler = new PreviewRefreshScheduler({
    now: () => Date.now(),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (timer) => window.clearTimeout(timer),
    visibility: {
      get visibilityState() { return state; },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
  });
  return {
    scheduler,
    visible(value: boolean) { state = value ? "visible" : "hidden"; listeners.forEach((listener) => listener()); },
    async advance(ms = 0) { await vi.advanceTimersByTimeAsync(ms); },
    cleanup() { scheduler.dispose(); vi.useRealTimers(); },
  };
}

describe("PreviewRefreshScheduler", () => {
  it("uses one global timer and single-flights an identical view/budget key", async () => {
    const h = harness();
    const read = vi.fn(async () => "shared");
    const first = vi.fn(); const second = vi.fn();
    h.scheduler.subscribe({ key: "same", eligible: () => true, read, commit: first });
    h.scheduler.subscribe({ key: "same", eligible: () => true, read, commit: second });
    expect(vi.getTimerCount()).toBe(1);
    await h.advance();
    expect(read).toHaveBeenCalledOnce(); expect(first).toHaveBeenCalledWith("shared"); expect(second).toHaveBeenCalledWith("shared");
    h.cleanup();
  });

  it("does not merge different keys, views, or budgets", async () => {
    const h = harness(); const reads = [vi.fn(async () => 1), vi.fn(async () => 2)];
    const base = { transport: "local" as const, logicalSessionId: "s", path: "/x" };
    h.scheduler.subscribe({ key: previewRefreshKey(base, "head", 10), eligible: () => true, read: reads[0], commit: vi.fn() });
    h.scheduler.subscribe({ key: previewRefreshKey(base, "tail", 20), eligible: () => true, read: reads[1], commit: vi.fn() });
    await h.advance(); expect(reads[0]).toHaveBeenCalledOnce(); expect(reads[1]).toHaveBeenCalledOnce(); h.cleanup();
  });

  it("waits while inactive, then poke requests immediately", async () => {
    const h = harness(); let active = false; const read = vi.fn(async () => 1);
    h.scheduler.subscribe({ key: "x", eligible: () => active, read, commit: vi.fn() });
    await h.advance(30_000); expect(read).not.toHaveBeenCalled();
    active = true; h.scheduler.poke(); await h.advance(); expect(read).toHaveBeenCalledOnce(); h.cleanup();
  });

  it("refreshes immediately when poked before the normal interval is due", async () => {
    const h = harness(); const read = vi.fn(async () => 1);
    h.scheduler.subscribe({ key: "x", eligible: () => true, read, commit: vi.fn() });
    await h.advance(); await h.advance(1_000); h.scheduler.poke(); await h.advance();
    expect(read).toHaveBeenCalledTimes(2); h.cleanup();
  });

  it("waits while hidden and requests immediately when visible", async () => {
    const h = harness(false); const read = vi.fn(async () => 1);
    h.scheduler.subscribe({ key: "x", eligible: () => true, read, commit: vi.fn() });
    await h.advance(30_000); expect(read).not.toHaveBeenCalled();
    h.visible(true); await h.advance(); expect(read).toHaveBeenCalledOnce(); h.cleanup();
  });

  it("backs failures off by 5/10/20/30 seconds", async () => {
    const h = harness(); const times: number[] = [];
    const read = vi.fn(async () => { times.push(Date.now()); throw new Error("no"); });
    h.scheduler.subscribe({ key: "x", eligible: () => true, read, commit: vi.fn() });
    await h.advance(); for (const delay of [5_000, 10_000, 20_000, 30_000]) await h.advance(delay);
    expect(times.slice(1).map((time, index) => time - times[index])).toEqual([5_000, 10_000, 20_000, 30_000]); h.cleanup();
  });

  it("forces a known-omitting reverify at 60 seconds", async () => {
    const h = harness(); const flags: boolean[] = [];
    h.scheduler.subscribe({ key: "x", eligible: () => true, read: async ({ force }) => { flags.push(force); }, commit: vi.fn() });
    await h.advance(); await h.advance(57_500); await h.advance(2_500);
    expect(flags[0]).toBe(true); expect(flags[flags.length - 1]).toBe(true); expect(flags.slice(1, -1)).not.toContain(true); h.cleanup();
  });

  it("does not commit late results after unsubscribe or eligibility generation replacement", async () => {
    const h = harness(); let resolve!: (value: string) => void; const commit = vi.fn();
    const unsubscribe = h.scheduler.subscribe({ key: "x", eligible: () => true, read: () => new Promise((done) => { resolve = done; }), commit });
    await h.advance(); unsubscribe(); resolve("late"); await Promise.resolve(); expect(commit).not.toHaveBeenCalled();
    h.cleanup();
  });

  it("does not commit an in-flight result after disposal", async () => {
    const h = harness(); let resolve!: (value: string) => void; const commit = vi.fn();
    h.scheduler.subscribe({ key: "x", eligible: () => true, read: () => new Promise((done) => { resolve = done; }), commit });
    await h.advance(); h.scheduler.dispose(); resolve("late"); await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
