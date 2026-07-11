import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/state/sessions";
import {
  probeTerminalInputEcho,
  probeTerminalHighOutput,
  readTerminalBenchmarkSnapshot,
  sampleAnimationFrames,
  summarizeDurations,
  TERMINAL_BENCHMARK_MODE,
  TERMINAL_BENCHMARK_VARIANT,
  TERMINAL_OUTPUT_BLOCK_BYTES,
  TERMINAL_OUTPUT_REFERENCE,
  terminalBenchmarkOverflowCount,
  waitForTerminalBenchmarkWriters,
} from "@/modules/terminal/lib/terminal-benchmark";

const MIN_MOUNTED_TERMINALS = 10;
const TARGET_MOUNTED_TERMINALS = 12;
const M1_OUTPUT_TERMINALS = 2;
const M1_DEFAULT_OUTPUT_BYTES = [50 * 1024 * 1024, 200 * 1024 * 1024];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function m1OutputSizes(): number[] {
  const configured: string | undefined = typeof import.meta.env !== "undefined"
    ? import.meta.env.VITE_TUNARA_BENCHMARK_OUTPUT_BYTES
    : undefined;
  if (!configured) return M1_DEFAULT_OUTPUT_BYTES;
  const parsed = configured
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value >= TERMINAL_OUTPUT_BLOCK_BYTES);
  return parsed.length > 0 ? parsed : M1_DEFAULT_OUTPUT_BYTES;
}

async function sampleControlInput(sessionId: string, nonce: string): Promise<number[]> {
  const latencies: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    await delay(index === 0 ? 250 : 500);
    latencies.push(await probeTerminalInputEcho(
      sessionId,
      `__TUNARA_M1_INPUT_${nonce}_${index}__`,
      10_000,
    ));
  }
  return latencies;
}

async function runM1OutputBenchmark(readyIds: string[]) {
  const floodSessionId = readyIds[0];
  const controlSessionId = readyIds[1];
  const nodePath = typeof import.meta.env !== "undefined"
    ? import.meta.env.VITE_TUNARA_BENCHMARK_NODE
    : undefined;
  const root = typeof import.meta.env !== "undefined"
    ? import.meta.env.VITE_TUNARA_BENCHMARK_ROOT
    : undefined;
  if (!floodSessionId || !controlSessionId) {
    throw new Error("M1 output benchmark requires two mounted terminals");
  }
  if (!nodePath || !root) {
    throw new Error("M1 output benchmark build is missing node/root paths");
  }

  const fixtures = [];
  for (const expectedBytes of m1OutputSizes()) {
    const nonce = `${Date.now().toString(36)}_${expectedBytes}`;
    const overflowBefore = terminalBenchmarkOverflowCount(floodSessionId);
    const framePromise = sampleAnimationFrames();
    const inputPromise = sampleControlInput(controlSessionId, nonce);
    const fixturePath = `${root}/scripts/terminal-output-fixture.mjs`;
    const command = [
      "old=$(stty -g)",
      "stty -echo -onlcr",
      `${shellQuote(nodePath)} ${shellQuote(fixturePath)} --bytes ${expectedBytes} --nonce ${nonce}`,
      "fixture_status=$?",
      'stty "$old"',
      "(exit $fixture_status)",
    ].join("; ") + "\n";
    const output = await probeTerminalHighOutput(
      floodSessionId,
      command,
      expectedBytes,
      nonce,
    );
    const renderDrainStartedAt = performance.now();
    const snapshot = await readTerminalBenchmarkSnapshot(floodSessionId);
    const renderDrainMs = Math.round((performance.now() - renderDrainStartedAt) * 100) / 100;
    const [frameDeltas, inputLatencies] = await Promise.all([framePromise, inputPromise]);
    const overflowCount = terminalBenchmarkOverflowCount(floodSessionId) - overflowBefore;
    const referenceVisible = snapshot.includes(TERMINAL_OUTPUT_REFERENCE);
    const inputEcho = summarizeDurations(inputLatencies);
    const frames = summarizeDurations(frameDeltas);
    fixtures.push({
      ...output,
      sizeMiB: Math.round(expectedBytes / 1024 / 1024),
      overflowCount,
      referenceVisible,
      renderDrainMs,
      inputEcho,
      frames,
      frameSampleValid: frameDeltas.length >= 60,
      passed: output.sequenceValid
        && output.receivedBytes === expectedBytes
        && overflowCount === 0
        && referenceVisible
        && frameDeltas.length >= 60
        && frames.p95Ms !== null
        && frames.p95Ms <= 33.4,
    });
    await delay(500);
  }
  return {
    benchmark: "m1-terminal-high-output",
    timestamp: new Date().toISOString(),
    readyTerminals: readyIds.length,
    blockBytes: TERMINAL_OUTPUT_BLOCK_BYTES,
    frameP95BudgetMs: 33.4,
    reference: TERMINAL_OUTPUT_REFERENCE,
    fixtures,
    passed: fixtures.length === m1OutputSizes().length
      && fixtures.every((fixture) => fixture.passed),
  };
}

export function useTerminalBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!TERMINAL_BENCHMARK_MODE || !ready || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const initial = useSessionsStore.getState();
      const targetCount = TERMINAL_BENCHMARK_VARIANT === "m1-output"
        ? M1_OUTPUT_TERMINALS
        : TARGET_MOUNTED_TERMINALS;
      const targets = initial.sessions
        .filter((session) => !session.remote)
        .slice(0, targetCount);
      const ids = targets.map((session) => session.id);
      const launchedSessionIds = Object.fromEntries(ids.map((id) => [id, true] as const));
      useSessionsStore.setState({
        launchedSessionIds,
        activeSessionId: initial.activeSessionId && ids.includes(initial.activeSessionId)
          ? initial.activeSessionId
          : ids[0] ?? null,
      });

      const readyIds = await waitForTerminalBenchmarkWriters(ids);
      if (cancelled) return;
      await delay(750);

      if (TERMINAL_BENCHMARK_VARIANT === "m1-output") {
        const { info, error } = await import("@tauri-apps/plugin-log");
        try {
          const report = await runM1OutputBenchmark(readyIds);
          if (cancelled) return;
          await info(`[benchmark:m1-output] ${JSON.stringify(report)}`);
        } catch (reason) {
          await error(`[benchmark:m1-output] ${JSON.stringify({
            benchmark: "m1-terminal-high-output",
            timestamp: new Date().toISOString(),
            passed: false,
            error: String(reason),
          })}`);
        }
        return;
      }

      const nonce = Date.now().toString(36);
      const framePromise = sampleAnimationFrames();
      const inputResults = await Promise.allSettled(
        readyIds.map((id, index) => probeTerminalInputEcho(
          id,
          `__TUNARA_M0_${index}_${nonce}__`,
        )),
      );
      const frameDeltas = await framePromise;
      if (cancelled) return;

      const inputLatencies = inputResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      const failures = inputResults.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ sessionId: readyIds[index], error: String(result.reason) }]
          : []
      );
      const report = {
        benchmark: "m0-mounted-terminals",
        timestamp: new Date().toISOString(),
        requestedTerminals: ids.length,
        readyTerminals: readyIds.length,
        minimumSatisfied: readyIds.length >= MIN_MOUNTED_TERMINALS,
        inputEcho: summarizeDurations(inputLatencies),
        frames: summarizeDurations(frameDeltas),
        frameSampleValid: frameDeltas.length >= 60,
        failures,
      };
      const { info } = await import("@tauri-apps/plugin-log");
      await info(`[benchmark:m0] ${JSON.stringify(report)}`);
    })();

    return () => {
      cancelled = true;
    };
  }, [ready]);
}
