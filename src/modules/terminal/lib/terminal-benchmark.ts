const configuredBenchmark = typeof import.meta.env !== "undefined"
  ? import.meta.env.VITE_TUNARA_BENCHMARK
  : undefined;

export type TerminalBenchmarkVariant = "m0" | "m1-output" | "m2-safe-write" | "m2-local-safe-write" | "m2-native-close" | "phase3-telemetry" | "phase3-restart" | "phase3-tunnel" | "phase3-capture" | "m3-timeline";
export const TERMINAL_BENCHMARK_VARIANT: TerminalBenchmarkVariant | null =
  configuredBenchmark === "m0" || configuredBenchmark === "m1-output" || configuredBenchmark === "m2-safe-write" || configuredBenchmark === "m2-local-safe-write" || configuredBenchmark === "m2-native-close" || configuredBenchmark === "phase3-telemetry" || configuredBenchmark === "phase3-restart" || configuredBenchmark === "phase3-tunnel" || configuredBenchmark === "phase3-capture" || configuredBenchmark === "m3-timeline"
    ? configuredBenchmark
    : null;
export const TERMINAL_BENCHMARK_MODE = TERMINAL_BENCHMARK_VARIANT !== null;
export type TerminalBenchmarkTransport = "local" | "ssh";
export const TERMINAL_BENCHMARK_TRANSPORT: TerminalBenchmarkTransport =
  (configuredBenchmark === "m1-output" || configuredBenchmark === "m2-safe-write")
    && import.meta.env.VITE_TUNARA_BENCHMARK_TRANSPORT === "ssh"
    ? "ssh"
    : "local";

export const TERMINAL_OUTPUT_BLOCK_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_BLOCK_HEADER_BYTES = 32;
export const TERMINAL_OUTPUT_REFERENCE = "TUNARA_M1_OK 中文 🐟 é 界 ┌─┐";

type BenchmarkWriter = (data: string) => Promise<void>;
type BenchmarkSnapshotReader = () => Promise<string>;
type BenchmarkRendererMode = "webgl" | "dom";

interface BenchmarkRendererControl {
  mode: () => BenchmarkRendererMode;
  loseContext: () => { triggered: boolean; method: string };
}

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

export interface AnimationFrameEvaluation {
  frames: DurationSummary;
  totalFrameDeltas: number;
  backgroundRafSuspended: boolean;
  frameSampleValid: boolean;
  passed: boolean;
}

const writers = new Map<string, BenchmarkWriter>();
const writerGenerations = new Map<string, number>();
const snapshotReaders = new Map<string, BenchmarkSnapshotReader>();
const rendererControls = new Map<string, BenchmarkRendererControl>();
const pendingInputProbes = new Map<string, PendingInputProbe>();
const outputOverflows = new Map<string, number>();
const exitEvents = new Map<string, number[]>();

interface PendingOutputProbe {
  tracker: TerminalOutputSequenceTracker;
  resolve: (result: TerminalOutputSequenceResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingOutputProbes = new Map<string, PendingOutputProbe>();

const encoder = new TextEncoder();

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.byteLength === 0) return from <= haystack.byteLength ? from : -1;
  const last = haystack.byteLength - needle.byteLength;
  outer: for (let index = Math.max(0, from); index <= last; index += 1) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function tailForMarker(bytes: Uint8Array, marker: Uint8Array): Uint8Array {
  const keep = Math.min(bytes.byteLength, Math.max(0, marker.byteLength - 1));
  return keep > 0 ? bytes.slice(bytes.byteLength - keep) : new Uint8Array();
}

export function terminalOutputBlockHeader(index: number): Uint8Array {
  const text = `@TUNARA-M1:${index.toString(16).padStart(8, "0")}@`
    .padEnd(TERMINAL_OUTPUT_BLOCK_HEADER_BYTES, "-");
  return encoder.encode(text);
}

export interface TerminalOutputSequenceResult {
  expectedBytes: number;
  receivedBytes: number;
  expectedBlocks: number;
  dataEvents: number;
  sequenceValid: boolean;
  firstSequenceError: string | null;
  transferMs: number;
}

export class TerminalOutputSequenceTracker {
  private readonly expectedBytes: number;
  private readonly startMarker: Uint8Array;
  private readonly endMarker: Uint8Array;
  private phase: "start" | "payload" | "end" | "complete" = "start";
  private seekTail: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private payloadBytes = 0;
  private dataEvents = 0;
  private firstSequenceError: string | null = null;
  private payloadStartedAt = 0;

  constructor(expectedBytes: number, nonce: string) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < TERMINAL_OUTPUT_BLOCK_BYTES) {
      throw new Error("terminal output fixture size is invalid");
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(nonce)) {
      throw new Error("terminal output fixture nonce is invalid");
    }
    this.expectedBytes = expectedBytes;
    this.startMarker = encoder.encode(`__TUNARA_M1_BEGIN_${nonce}__`);
    this.endMarker = encoder.encode(`__TUNARA_M1_END_${nonce}__`);
  }

  push(data: Uint8Array): TerminalOutputSequenceResult | null {
    if (this.phase === "complete") return null;
    const phaseBefore = this.phase;
    const result = this.consume(data);
    if (phaseBefore !== "start" || this.phase !== "start") this.dataEvents += 1;
    if (!result) return null;
    this.phase = "complete";
    return {
      expectedBytes: this.expectedBytes,
      receivedBytes: this.payloadBytes,
      expectedBlocks: Math.ceil(this.expectedBytes / TERMINAL_OUTPUT_BLOCK_BYTES),
      dataEvents: this.dataEvents,
      sequenceValid: this.firstSequenceError === null,
      firstSequenceError: this.firstSequenceError,
      transferMs: Math.round((performance.now() - this.payloadStartedAt) * 100) / 100,
    };
  }

  private consume(data: Uint8Array): boolean {
    let remaining = data;
    if (this.phase === "start") {
      const combined = concatBytes(this.seekTail, remaining);
      const markerAt = indexOfBytes(combined, this.startMarker);
      if (markerAt < 0) {
        this.seekTail = tailForMarker(combined, this.startMarker);
        return false;
      }
      const newlineAt = combined.indexOf(0x0a, markerAt + this.startMarker.byteLength);
      if (newlineAt < 0) {
        this.seekTail = combined.slice(markerAt);
        return false;
      }
      this.phase = "payload";
      this.payloadStartedAt = performance.now();
      this.seekTail = new Uint8Array();
      remaining = combined.slice(newlineAt + 1);
    }

    if (this.phase === "payload") {
      let offset = 0;
      while (offset < remaining.byteLength && this.payloadBytes < this.expectedBytes) {
        const blockOffset = this.payloadBytes % TERMINAL_OUTPUT_BLOCK_BYTES;
        const payloadRemaining = this.expectedBytes - this.payloadBytes;
        if (blockOffset < TERMINAL_OUTPUT_BLOCK_HEADER_BYTES) {
          const blockIndex = Math.floor(this.payloadBytes / TERMINAL_OUTPUT_BLOCK_BYTES);
          const expected = terminalOutputBlockHeader(blockIndex);
          const take = Math.min(
            remaining.byteLength - offset,
            TERMINAL_OUTPUT_BLOCK_HEADER_BYTES - blockOffset,
            payloadRemaining,
          );
          if (this.firstSequenceError === null) {
            for (let index = 0; index < take; index += 1) {
              if (remaining[offset + index] !== expected[blockOffset + index]) {
                this.firstSequenceError = `block ${blockIndex} header mismatch at byte ${blockOffset + index}`;
                break;
              }
            }
          }
          offset += take;
          this.payloadBytes += take;
          continue;
        }
        const toBlockEnd = TERMINAL_OUTPUT_BLOCK_BYTES - blockOffset;
        const take = Math.min(remaining.byteLength - offset, toBlockEnd, payloadRemaining);
        offset += take;
        this.payloadBytes += take;
      }
      remaining = remaining.slice(offset);
      if (this.payloadBytes === this.expectedBytes) {
        this.phase = "end";
      }
    }

    if (this.phase === "end") {
      const combined = concatBytes(this.seekTail, remaining);
      if (indexOfBytes(combined, this.endMarker) >= 0) return true;
      this.seekTail = tailForMarker(combined, this.endMarker);
    }
    return false;
  }
}

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

export function evaluateAnimationFrames(
  deltas: readonly number[],
  p95BudgetMs = 33.4,
  minimumVisibleSamples = 60,
  backgroundGapMs = 1_000,
): AnimationFrameEvaluation {
  const visibleDeltas = deltas.filter((delta) => delta < backgroundGapMs);
  const frames = summarizeDurations(visibleDeltas);
  const backgroundRafSuspended = deltas.some((delta) => delta >= backgroundGapMs);
  const frameSampleValid = visibleDeltas.length >= minimumVisibleSamples;
  return {
    frames,
    totalFrameDeltas: deltas.length,
    backgroundRafSuspended,
    frameSampleValid,
    passed: (frameSampleValid || backgroundRafSuspended)
      && frames.p95Ms !== null
      && frames.p95Ms <= p95BudgetMs,
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
  writerGenerations.set(sessionId, (writerGenerations.get(sessionId) ?? 0) + 1);
  writers.set(sessionId, writer);
  return () => {
    if (writers.get(sessionId) === writer) writers.delete(sessionId);
  };
}

export function terminalBenchmarkWriterGeneration(sessionId: string): number {
  return writerGenerations.get(sessionId) ?? 0;
}

export async function waitForTerminalBenchmarkWriterGeneration(
  sessionId: string,
  afterGeneration: number,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const generation = terminalBenchmarkWriterGeneration(sessionId);
    if (generation > afterGeneration && writers.has(sessionId)) return generation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`benchmark writer did not reconnect: ${sessionId}`);
}

export function writeTerminalBenchmark(sessionId: string, data: string): Promise<void> {
  const writer = writers.get(sessionId);
  return writer
    ? writer(data)
    : Promise.reject(new Error(`benchmark writer unavailable: ${sessionId}`));
}

export function recordTerminalBenchmarkExit(sessionId: string, code: number): void {
  if (!TERMINAL_BENCHMARK_MODE) return;
  const events = exitEvents.get(sessionId) ?? [];
  events.push(code);
  exitEvents.set(sessionId, events);
}

export function terminalBenchmarkExitCount(sessionId: string): number {
  return exitEvents.get(sessionId)?.length ?? 0;
}

export async function waitForTerminalBenchmarkExit(
  sessionId: string,
  afterCount: number,
  expectedCode: number,
  timeoutMs = 30_000,
): Promise<{ code: number; count: number }> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const events = exitEvents.get(sessionId) ?? [];
    if (events.length > afterCount) {
      const code = events[afterCount];
      if (code !== expectedCode) {
        throw new Error(`benchmark terminal exited with ${code}, expected ${expectedCode}`);
      }
      return { code, count: events.length };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`benchmark terminal exit timed out: ${sessionId}`);
}

export function registerTerminalBenchmarkSnapshotReader(
  sessionId: string,
  reader: BenchmarkSnapshotReader,
): () => void {
  if (!TERMINAL_BENCHMARK_MODE) return () => {};
  snapshotReaders.set(sessionId, reader);
  return () => {
    if (snapshotReaders.get(sessionId) === reader) snapshotReaders.delete(sessionId);
  };
}

export function registerTerminalBenchmarkRendererControl(
  sessionId: string,
  control: BenchmarkRendererControl,
): () => void {
  if (!TERMINAL_BENCHMARK_MODE) return () => {};
  rendererControls.set(sessionId, control);
  return () => {
    if (rendererControls.get(sessionId) === control) rendererControls.delete(sessionId);
  };
}

export function terminalBenchmarkRendererMode(sessionId: string): BenchmarkRendererMode | null {
  return rendererControls.get(sessionId)?.mode() ?? null;
}

export async function triggerTerminalBenchmarkContextLoss(
  sessionId: string,
  // xterm deliberately allows three seconds for WebGL to restore before it
  // emits onContextLoss. Leave headroom so this checks the real fallback path.
  timeoutMs = 5_000,
): Promise<{ before: BenchmarkRendererMode; after: BenchmarkRendererMode; triggered: boolean; method: string }> {
  const control = rendererControls.get(sessionId);
  if (!control) throw new Error(`benchmark renderer control unavailable: ${sessionId}`);
  const before = control.mode();
  const trigger = control.loseContext();
  const deadline = performance.now() + timeoutMs;
  while (control.mode() !== "dom" && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { before, after: control.mode(), ...trigger };
}

export function readTerminalBenchmarkSnapshot(sessionId: string): Promise<string> {
  const reader = snapshotReaders.get(sessionId);
  return reader
    ? reader()
    : Promise.reject(new Error(`benchmark snapshot reader unavailable: ${sessionId}`));
}

export function recordTerminalBenchmarkOverflow(sessionId: string): void {
  if (!TERMINAL_BENCHMARK_MODE) return;
  outputOverflows.set(sessionId, (outputOverflows.get(sessionId) ?? 0) + 1);
}

export function terminalBenchmarkOverflowCount(sessionId: string): number {
  return outputOverflows.get(sessionId) ?? 0;
}

export function probeTerminalHighOutput(
  sessionId: string,
  command: string,
  expectedBytes: number,
  nonce: string,
  timeoutMs = 10 * 60_000,
): Promise<TerminalOutputSequenceResult> {
  const writer = writers.get(sessionId);
  if (!writer) return Promise.reject(new Error(`benchmark writer unavailable: ${sessionId}`));

  return new Promise((resolve, reject) => {
    const previous = pendingOutputProbes.get(sessionId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.reject(new Error(`benchmark output probe superseded: ${sessionId}`));
    }
    const probe: PendingOutputProbe = {
      tracker: new TerminalOutputSequenceTracker(expectedBytes, nonce),
      resolve,
      reject,
      timer: setTimeout(() => {
        if (pendingOutputProbes.get(sessionId) !== probe) return;
        pendingOutputProbes.delete(sessionId);
        reject(new Error(`benchmark output timed out: ${sessionId}`));
      }, timeoutMs),
    };
    pendingOutputProbes.set(sessionId, probe);
    void writer(command).catch((error) => {
      if (pendingOutputProbes.get(sessionId) !== probe) return;
      pendingOutputProbes.delete(sessionId);
      clearTimeout(probe.timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function recordTerminalBenchmarkOutput(sessionId: string, bytes: Uint8Array): void {
  if (!TERMINAL_BENCHMARK_MODE) return;
  const outputProbe = pendingOutputProbes.get(sessionId);
  if (outputProbe) {
    const result = outputProbe.tracker.push(bytes);
    if (result) {
      pendingOutputProbes.delete(sessionId);
      clearTimeout(outputProbe.timer);
      outputProbe.resolve(result);
    }
  }
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
  return probeTerminalCommandMarker(
    sessionId,
    `printf '%s\\n' '${marker}'\n`,
    marker,
    timeoutMs,
  );
}

export function probeTerminalCommandMarker(
  sessionId: string,
  command: string,
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
    void writer(command).catch((error) => {
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
