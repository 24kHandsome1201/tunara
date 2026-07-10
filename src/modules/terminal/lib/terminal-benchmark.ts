export const TERMINAL_BENCHMARK_MODE =
  typeof import.meta.env !== "undefined"
  && import.meta.env.VITE_TUNARA_BENCHMARK === "m0";

type BenchmarkWriter = (data: string) => Promise<void>;

interface PendingInputProbe {
  marker: string;
  startedAt: number;
  decoder: TextDecoder;
  tail: string;
  resolve: (latencyMs: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DurationSummary {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

const writers = new Map<string, BenchmarkWriter>();
const pendingInputProbes = new Map<string, PendingInputProbe>();

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, percentileValue));
  const index = Math.min(sorted.length - 1, Math.ceil(clamped * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function summarizeDurations(values: readonly number[]): DurationSummary {
  return {
    count: values.length,
    p50Ms: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
    maxMs: rounded(values.length > 0 ? Math.max(...values) : null),
  };
}

export function scanBenchmarkMarker(
  tail: string,
  chunk: string,
  marker: string,
): { matched: boolean; tail: string } {
  const text = tail + chunk;
  return {
    matched: text.includes(marker),
    tail: text.slice(-Math.max(1, marker.length - 1)),
  };
}

export function registerTerminalBenchmarkWriter(
  sessionId: string,
  writer: BenchmarkWriter,
): () => void {
  if (!TERMINAL_BENCHMARK_MODE) return () => {};
  writers.set(sessionId, writer);
  return () => {
    if (writers.get(sessionId) === writer) writers.delete(sessionId);
  };
}

export function recordTerminalBenchmarkOutput(sessionId: string, bytes: Uint8Array): void {
  if (!TERMINAL_BENCHMARK_MODE) return;
  const probe = pendingInputProbes.get(sessionId);
  if (!probe) return;
  const scanned = scanBenchmarkMarker(
    probe.tail,
    probe.decoder.decode(bytes, { stream: true }),
    probe.marker,
  );
  if (scanned.matched) {
    pendingInputProbes.delete(sessionId);
    clearTimeout(probe.timer);
    probe.resolve(performance.now() - probe.startedAt);
    return;
  }
  probe.tail = scanned.tail;
}

export async function waitForTerminalBenchmarkWriters(
  sessionIds: readonly string[],
  timeoutMs = 20_000,
): Promise<string[]> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const ready = sessionIds.filter((id) => writers.has(id));
    if (ready.length === sessionIds.length) return ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return sessionIds.filter((id) => writers.has(id));
}

export function probeTerminalInputEcho(
  sessionId: string,
  marker: string,
  timeoutMs = 5_000,
): Promise<number> {
  const writer = writers.get(sessionId);
  if (!writer) return Promise.reject(new Error(`benchmark writer unavailable: ${sessionId}`));

  return new Promise((resolve, reject) => {
    const previous = pendingInputProbes.get(sessionId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error(`benchmark probe superseded: ${sessionId}`));
    }

    const probe: PendingInputProbe = {
      marker,
      startedAt: performance.now(),
      decoder: new TextDecoder(),
      tail: "",
      resolve,
      reject,
      timer: setTimeout(() => {
        if (pendingInputProbes.get(sessionId) !== probe) return;
        pendingInputProbes.delete(sessionId);
        reject(new Error(`benchmark input echo timed out: ${sessionId}`));
      }, timeoutMs),
    };
    pendingInputProbes.set(sessionId, probe);
    void writer(`printf '%s\\n' '${marker}'\n`).catch((error) => {
      if (pendingInputProbes.get(sessionId) !== probe) return;
      pendingInputProbes.delete(sessionId);
      clearTimeout(probe.timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function sampleAnimationFrames(durationMs = 5_000): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let previous: number | null = null;
    let frameId = 0;
    let settled = false;
    const startedAt = performance.now();

    const finish = () => {
      if (settled) return;
      settled = true;
      if (frameId) cancelAnimationFrame(frameId);
      clearTimeout(timeout);
      resolve(deltas);
    };
    const tick = (now: number) => {
      if (previous !== null) deltas.push(now - previous);
      previous = now;
      if (now - startedAt >= durationMs) finish();
      else frameId = requestAnimationFrame(tick);
    };
    const timeout = setTimeout(finish, durationMs + 1_000);
    frameId = requestAnimationFrame(tick);
  });
}
