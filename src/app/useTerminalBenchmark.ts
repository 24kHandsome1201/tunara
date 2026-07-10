import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/state/sessions";
import {
  probeTerminalInputEcho,
  sampleAnimationFrames,
  summarizeDurations,
  TERMINAL_BENCHMARK_MODE,
  waitForTerminalBenchmarkWriters,
} from "@/modules/terminal/lib/terminal-benchmark";

const MIN_MOUNTED_TERMINALS = 10;
const TARGET_MOUNTED_TERMINALS = 12;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useTerminalBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!TERMINAL_BENCHMARK_MODE || !ready || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const initial = useSessionsStore.getState();
      const targets = initial.sessions
        .filter((session) => !session.remote)
        .slice(0, TARGET_MOUNTED_TERMINALS);
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
