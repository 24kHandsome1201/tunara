import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/state/sessions";
import {
  evaluateAnimationFrames,
  probeTerminalInputEcho,
  probeTerminalCommandMarker,
  probeTerminalHighOutput,
  readTerminalBenchmarkSnapshot,
  terminalBenchmarkExitCount,
  sampleAnimationFrames,
  summarizeDurations,
  TERMINAL_BENCHMARK_MODE,
  TERMINAL_BENCHMARK_TRANSPORT,
  TERMINAL_BENCHMARK_VARIANT,
  TERMINAL_OUTPUT_BLOCK_BYTES,
  TERMINAL_OUTPUT_REFERENCE,
  terminalBenchmarkOverflowCount,
  terminalBenchmarkRendererMode,
  terminalBenchmarkWriterGeneration,
  triggerTerminalBenchmarkContextLoss,
  waitForTerminalBenchmarkExit,
  waitForTerminalBenchmarkWriterGeneration,
  waitForTerminalBenchmarkWriters,
  writeTerminalBenchmark,
} from "@/modules/terminal/lib/terminal-benchmark";
import { SSH_DISCONNECTED_EXIT_CODE } from "@/modules/terminal/lib/pty-bridge";

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

function m1FixtureTimeoutMs(): number {
  const configured: string | undefined = typeof import.meta.env !== "undefined"
    ? import.meta.env.VITE_TUNARA_BENCHMARK_FIXTURE_TIMEOUT_MS
    : undefined;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= 1_000
    ? parsed
    : 10 * 60_000;
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

export async function disconnectAndReconnectSshBenchmarkSession(sessionId: string) {
  const store = useSessionsStore.getState();
  const sessionBefore = store.sessions.find((session) => session.id === sessionId);
  if (!sessionBefore?.remote) throw new Error("SSH recovery benchmark requires a remote session");

  const exitCountBefore = terminalBenchmarkExitCount(sessionId);
  const writerGenerationBefore = terminalBenchmarkWriterGeneration(sessionId);
  const disconnectStartedAt = performance.now();
  await writeTerminalBenchmark(sessionId, 'kill -9 "$PPID"\n');
  const exit = await waitForTerminalBenchmarkExit(
    sessionId,
    exitCountBefore,
    SSH_DISCONNECTED_EXIT_CODE,
  );
  const disconnectMs = Math.round((performance.now() - disconnectStartedAt) * 100) / 100;
  await delay(50);

  const disconnectedSession = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
  const disconnectedEvidence = disconnectedSession?.connection;
  const reconnectStartedAt = performance.now();
  const reconnectNonce = (disconnectedSession?.reconnectNonce ?? 0) + 1;
  useSessionsStore.getState().updateSession(sessionId, {
    ptyId: undefined,
    runState: "idle",
    startedAt: undefined,
    completedAt: undefined,
    lastExitCode: undefined,
    terminalProgress: undefined,
    reconnectNonce,
    terminalMountNonce: reconnectNonce,
  });
  useSessionsStore.getState().handleConnectionEvent(sessionId, {
    type: "openRequested",
    transport: "ssh",
    source: "user",
  });
  useSessionsStore.getState().setActive(sessionId);

  const writerGenerationAfter = await waitForTerminalBenchmarkWriterGeneration(
    sessionId,
    writerGenerationBefore,
  );
  const reconnectMs = Math.round((performance.now() - reconnectStartedAt) * 100) / 100;
  const marker = `__TUNARA_M1_SSH_RECOVERED_${Date.now().toString(36)}__`;
  const cwdReference = `${marker}:${sessionBefore.dir}`;
  const markerEchoMs = Math.round((await probeTerminalCommandMarker(
    sessionId,
    `printf '%s:%s\\n' '${marker}' "$PWD"\n`,
    cwdReference,
  )) * 100) / 100;
  const snapshot = await readTerminalBenchmarkSnapshot(sessionId);
  const recoveredSession = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
  const exitCountAfter = terminalBenchmarkExitCount(sessionId);
  const markerVisible = snapshot.includes(marker);
  const cwdReferenceVisible = snapshot.includes(cwdReference);

  return {
    exitCode: exit.code,
    exitCountBefore,
    exitCountAfter,
    disconnectMs,
    disconnectedPhase: disconnectedEvidence?.phase ?? null,
    disconnectedEvidenceExitCode: disconnectedEvidence?.exitCode ?? null,
    writerGenerationBefore,
    writerGenerationAfter,
    reconnectMs,
    markerEchoMs,
    markerVisible,
    cwd: sessionBefore.dir,
    cwdReferenceVisible,
    recoveredPhase: recoveredSession?.connection?.phase ?? null,
    passed: exit.code === SSH_DISCONNECTED_EXIT_CODE
      && exit.count === exitCountBefore + 1
      && exitCountAfter === exitCountBefore + 1
      && disconnectedEvidence?.phase === "disconnected"
      && disconnectedEvidence.exitCode === SSH_DISCONNECTED_EXIT_CODE
      && writerGenerationAfter > writerGenerationBefore
      && markerVisible
      && cwdReferenceVisible
      && recoveredSession?.connection?.phase === "ready",
  };
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
  const configuredFixturePath = typeof import.meta.env !== "undefined"
    ? import.meta.env.VITE_TUNARA_BENCHMARK_FIXTURE_PATH
    : undefined;
  if (!floodSessionId || !controlSessionId) {
    throw new Error("M1 output benchmark requires two mounted terminals");
  }
  const fixturePath = configuredFixturePath || (root ? `${root}/scripts/terminal-output-fixture.mjs` : undefined);
  if (!nodePath || !fixturePath) {
    throw new Error("M1 output benchmark build is missing node/fixture paths");
  }

  const fallbackNonce = Date.now().toString(36);
  const contextLoss = await triggerTerminalBenchmarkContextLoss(floodSessionId);
  const fallbackMarker = `__TUNARA_M1_DOM_FALLBACK_${fallbackNonce}__`;
  await probeTerminalInputEcho(floodSessionId, fallbackMarker);
  const fallbackSnapshot = await readTerminalBenchmarkSnapshot(floodSessionId);
  const fallbackReferenceVisible = fallbackSnapshot.includes(fallbackMarker);
  useSessionsStore.setState({ activeSessionId: controlSessionId });
  await delay(250);
  useSessionsStore.setState({ activeSessionId: floodSessionId });
  await delay(750);
  const afterReactivation = terminalBenchmarkRendererMode(floodSessionId);
  const webglFallback = {
    ...contextLoss,
    fallbackReferenceVisible,
    afterReactivation,
    passed: contextLoss.before === "webgl"
      && contextLoss.triggered
      && contextLoss.after === "dom"
      && fallbackReferenceVisible
      && afterReactivation === "webgl",
  };

  const fixtures = [];
  for (const expectedBytes of m1OutputSizes()) {
    const nonce = `${Date.now().toString(36)}_${expectedBytes}`;
    const overflowBefore = terminalBenchmarkOverflowCount(floodSessionId);
    const framePromise = sampleAnimationFrames();
    const inputPromise = sampleControlInput(controlSessionId, nonce);
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
      m1FixtureTimeoutMs(),
    );
    const renderDrainStartedAt = performance.now();
    const snapshot = await readTerminalBenchmarkSnapshot(floodSessionId);
    const renderDrainMs = Math.round((performance.now() - renderDrainStartedAt) * 100) / 100;
    const [frameDeltas, inputLatencies] = await Promise.all([framePromise, inputPromise]);
    const overflowCount = terminalBenchmarkOverflowCount(floodSessionId) - overflowBefore;
    const referenceVisible = snapshot.includes(TERMINAL_OUTPUT_REFERENCE);
    const inputEcho = summarizeDurations(inputLatencies);
    const frameEvaluation = evaluateAnimationFrames(frameDeltas);
    fixtures.push({
      ...output,
      sizeMiB: Math.round(expectedBytes / 1024 / 1024),
      overflowCount,
      referenceVisible,
      renderDrainMs,
      inputEcho,
      ...frameEvaluation,
      passed: output.sequenceValid
        && output.receivedBytes === expectedBytes
        && overflowCount === 0
        && referenceVisible
        && frameEvaluation.passed,
    });
    await delay(500);
  }
  let sshRecovery: Awaited<ReturnType<typeof disconnectAndReconnectSshBenchmarkSession>> | { passed: false; error: string } | null = null;
  if (TERMINAL_BENCHMARK_TRANSPORT === "ssh") {
    try {
      sshRecovery = await disconnectAndReconnectSshBenchmarkSession(floodSessionId);
    } catch (error) {
      sshRecovery = { passed: false, error: String(error) };
    }
  }
  return {
    benchmark: "m1-terminal-high-output",
    transport: TERMINAL_BENCHMARK_TRANSPORT,
    timestamp: new Date().toISOString(),
    readyTerminals: readyIds.length,
    blockBytes: TERMINAL_OUTPUT_BLOCK_BYTES,
    frameP95BudgetMs: 33.4,
    fixtureTimeoutMs: m1FixtureTimeoutMs(),
    reference: TERMINAL_OUTPUT_REFERENCE,
    webglFallback,
    sshRecovery,
    fixtures,
    passed: webglFallback.passed
      && (sshRecovery === null || sshRecovery.passed)
      && fixtures.length === m1OutputSizes().length
      && fixtures.every((fixture) => fixture.passed),
  };
}

export function useTerminalBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!TERMINAL_BENCHMARK_MODE || TERMINAL_BENCHMARK_VARIANT === "m2-safe-write" || TERMINAL_BENCHMARK_VARIANT === "m2-local-safe-write" || TERMINAL_BENCHMARK_VARIANT === "m2-native-close" || TERMINAL_BENCHMARK_VARIANT === "phase3-telemetry" || TERMINAL_BENCHMARK_VARIANT === "phase3-restart" || TERMINAL_BENCHMARK_VARIANT === "phase3-tunnel" || TERMINAL_BENCHMARK_VARIANT === "phase3-capture" || !ready || startedRef.current) return;
    startedRef.current = true;
    const appReadyMs = performance.now();
    let cancelled = false;

    void (async () => {
      const initial = useSessionsStore.getState();
      const targetCount = TERMINAL_BENCHMARK_VARIANT === "m1-output"
        ? M1_OUTPUT_TERMINALS
        : TARGET_MOUNTED_TERMINALS;
      const targets = initial.sessions
        .filter((session) => TERMINAL_BENCHMARK_TRANSPORT === "ssh"
          ? Boolean(session.remote)
          : !session.remote)
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
      const writersReadyMs = performance.now();
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
      let firstInputReadyMs: number | null = null;
      const inputResults = await Promise.allSettled(
        readyIds.map((id, index) => probeTerminalInputEcho(
          id,
          `__TUNARA_M0_${index}_${nonce}__`,
        ).then((latency) => {
          firstInputReadyMs ??= performance.now();
          return latency;
        })),
      );
      const allInputsReadyMs = performance.now();
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
        startup: {
          webviewTimeOriginEpochMs: performance.timeOrigin,
          appReadyMs: Math.round(appReadyMs * 100) / 100,
          writersReadyMs: Math.round(writersReadyMs * 100) / 100,
          firstInputReadyMs: firstInputReadyMs === null ? null : Math.round(firstInputReadyMs * 100) / 100,
          allInputsReadyMs: Math.round(allInputsReadyMs * 100) / 100,
        },
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
