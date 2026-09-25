import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import {
  evaluateAnimationFrames,
  mebibytesPerSecond,
  probeTerminalHighOutput,
  readTerminalBenchmarkSnapshot,
  startAnimationFrameSampler,
  TERMINAL_BENCHMARK_RENDERER,
  TERMINAL_BENCHMARK_VARIANT,
  TERMINAL_OUTPUT_BLOCK_BYTES,
  TERMINAL_OUTPUT_REFERENCE,
  terminalBenchmarkRendererMode,
  waitForTerminalBenchmarkWriters,
  type RendererBenchmarkReport,
} from "@/modules/terminal/lib/terminal-benchmark";

/**
 * Pre-release renderer benchmark. Mounts four local sessions in a 2×2 split,
 * floods one pane with the mixed CJK/Latin/ANSI fixture to measure
 * throughput, then floods all four at once to measure frame time under a
 * four-pane load. The renderer is pinned by `VITE_TUNARA_BENCHMARK_RENDERER`
 * (see `TERMINAL_BENCHMARK_RENDERER_OVERRIDE`), so running the harness twice
 * yields the WebGL-vs-DOM comparison table.
 */

const PANES = 4;
const FRAME_P95_BUDGET_MS = 33.4;
const DEFAULT_THROUGHPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_PANE_BYTES = 8 * 1024 * 1024;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function envBytes(name: string, fallback: number): number {
  const configured: string | undefined = typeof import.meta.env !== "undefined"
    ? import.meta.env[name]
    : undefined;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= TERMINAL_OUTPUT_BLOCK_BYTES ? parsed : fallback;
}

function fixtureCommand(nodePath: string, fixturePath: string, bytes: number, nonce: string): string {
  return [
    "old=$(stty -g)",
    "stty -echo -onlcr",
    `${shellQuote(nodePath)} ${shellQuote(fixturePath)} --bytes ${bytes} --nonce ${nonce}`,
    "fixture_status=$?",
    'stty "$old"',
    "(exit $fixture_status)",
  ].join("; ") + "\n";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function focusEachPane(ids: readonly string[]): Promise<void> {
  // Split panes only pick up a WebGL context once they have been the active
  // pane, so visit each one before measuring.
  for (const id of ids) {
    useUIStore.getState().setFocusedPaneId(id);
    useSessionsStore.getState().setActive(id);
    await delay(400);
  }
  useUIStore.getState().setFocusedPaneId(ids[0]);
  useSessionsStore.getState().setActive(ids[0]);
  await delay(400);
}

function buildTwoByTwoSplit(ids: readonly string[]): void {
  const ui = useUIStore.getState();
  ui.closeSplit();
  if (!ui.splitPane(ids[0], ids[1], "horizontal")) throw new Error("renderer benchmark could not open the first split");
  if (!ui.splitPane(ids[0], ids[2], "vertical")) throw new Error("renderer benchmark could not open the second split");
  if (!ui.splitPane(ids[1], ids[3], "vertical")) throw new Error("renderer benchmark could not open the third split");
}

async function runRendererBenchmark(readyIds: readonly string[]): Promise<RendererBenchmarkReport> {
  const nodePath = typeof import.meta.env !== "undefined" ? import.meta.env.VITE_TUNARA_BENCHMARK_NODE : undefined;
  const root = typeof import.meta.env !== "undefined" ? import.meta.env.VITE_TUNARA_BENCHMARK_ROOT : undefined;
  const configuredFixturePath = typeof import.meta.env !== "undefined" ? import.meta.env.VITE_TUNARA_BENCHMARK_FIXTURE_PATH : undefined;
  const fixturePath = configuredFixturePath || (root ? `${root}/scripts/terminal-output-fixture.mjs` : undefined);
  if (readyIds.length < PANES) throw new Error(`renderer benchmark requires ${PANES} mounted terminals, got ${readyIds.length}`);
  if (!nodePath || !fixturePath) throw new Error("renderer benchmark build is missing node/fixture paths");
  const ids = readyIds.slice(0, PANES);

  buildTwoByTwoSplit(ids);
  await delay(750);
  await focusEachPane(ids);
  const paneRenderers = ids.map((id) => terminalBenchmarkRendererMode(id) ?? "dom");

  const throughputBytes = envBytes("VITE_TUNARA_BENCHMARK_OUTPUT_BYTES", DEFAULT_THROUGHPUT_BYTES);
  const throughputNonce = `${Date.now().toString(36)}_tp`;
  const throughputSampler = startAnimationFrameSampler();
  const throughputStartedAt = performance.now();
  const throughputOutput = await probeTerminalHighOutput(
    ids[0],
    fixtureCommand(nodePath, fixturePath, throughputBytes, throughputNonce),
    throughputBytes,
    throughputNonce,
  );
  const throughputElapsedMs = performance.now() - throughputStartedAt;
  const drainStartedAt = performance.now();
  const throughputSnapshot = await readTerminalBenchmarkSnapshot(ids[0]);
  const renderDrainMs = performance.now() - drainStartedAt;
  const throughputFrames = evaluateAnimationFrames(throughputSampler.stop(), FRAME_P95_BUDGET_MS, 1);
  await delay(750);

  const paneBytes = envBytes("VITE_TUNARA_BENCHMARK_PANE_BYTES", DEFAULT_PANE_BYTES);
  const paneNonce = Date.now().toString(36);
  const fourPaneSampler = startAnimationFrameSampler();
  const fourPaneStartedAt = performance.now();
  const outputs = await Promise.all(ids.map((id, index) => probeTerminalHighOutput(
    id,
    fixtureCommand(nodePath, fixturePath, paneBytes, `${paneNonce}_${index}`),
    paneBytes,
    `${paneNonce}_${index}`,
  )));
  const fourPaneElapsedMs = performance.now() - fourPaneStartedAt;
  const fourPaneFrames = evaluateAnimationFrames(fourPaneSampler.stop(), FRAME_P95_BUDGET_MS, 1);
  const snapshots = await Promise.all(ids.map((id) => readTerminalBenchmarkSnapshot(id)));
  const referencesVisible = snapshots.filter((snapshot) => snapshot.includes(TERMINAL_OUTPUT_REFERENCE)).length;
  const paneOutputsValid = outputs.every((output) => output.sequenceValid && output.receivedBytes === paneBytes);

  const throughput = {
    bytes: throughputBytes,
    elapsedMs: round(throughputElapsedMs),
    mebibytesPerSecond: mebibytesPerSecond(throughputBytes, throughputElapsedMs),
    renderDrainMs: round(renderDrainMs),
    referenceVisible: throughputSnapshot.includes(TERMINAL_OUTPUT_REFERENCE),
    sequenceValid: throughputOutput.sequenceValid && throughputOutput.receivedBytes === throughputBytes,
    frames: throughputFrames.frames,
  };
  const fourPane = {
    panes: PANES,
    bytesPerPane: paneBytes,
    elapsedMs: round(fourPaneElapsedMs),
    frames: fourPaneFrames.frames,
    frameP95BudgetMs: FRAME_P95_BUDGET_MS,
    referencesVisible,
  };
  return {
    benchmark: "renderer",
    renderer: TERMINAL_BENCHMARK_RENDERER,
    timestamp: new Date().toISOString(),
    paneRenderers,
    throughput,
    fourPane,
    passed: paneRenderers.every((mode) => mode === TERMINAL_BENCHMARK_RENDERER)
      && throughput.sequenceValid
      && throughput.referenceVisible
      && paneOutputsValid
      && referencesVisible === PANES
      && fourPaneFrames.passed,
  };
}

export function useRendererBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "renderer" || !ready || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const initial = useSessionsStore.getState();
      const ids = initial.sessions.filter((session) => !session.remote).slice(0, PANES).map((session) => session.id);
      useSessionsStore.setState({
        launchedSessionIds: Object.fromEntries(ids.map((id) => [id, true] as const)),
        activeSessionId: ids[0] ?? null,
      });
      const readyIds = await waitForTerminalBenchmarkWriters(ids);
      if (cancelled) return;
      await delay(750);
      const { info, error } = await import("@tauri-apps/plugin-log");
      try {
        const report = await runRendererBenchmark(readyIds);
        if (cancelled) return;
        await info(`[benchmark:renderer] ${JSON.stringify(report)}`);
      } catch (reason) {
        await error(`[benchmark:renderer] ${JSON.stringify({
          benchmark: "renderer",
          renderer: TERMINAL_BENCHMARK_RENDERER,
          timestamp: new Date().toISOString(),
          passed: false,
          error: String(reason),
        })}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready]);
}
