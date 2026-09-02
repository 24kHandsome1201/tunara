import { useM2LocalSafeWriteBenchmark } from "../useM2LocalSafeWriteBenchmark";
import { useM2NativeCloseBenchmark } from "../useM2NativeCloseBenchmark";
import { useM2SafeWriteBenchmark } from "../useM2SafeWriteBenchmark";
import { usePhase3RestartBenchmark } from "../usePhase3RestartBenchmark";
import { usePhase3TunnelBenchmark } from "../usePhase3TunnelBenchmark";
import { useTerminalBenchmark } from "../useTerminalBenchmark";

/** Mounts every GUI benchmark harness. Loaded only when VITE_TUNARA_BENCHMARK is set. */
export function useBenchmarks(ready: boolean): void {
  useTerminalBenchmark(ready);
  usePhase3RestartBenchmark(ready);
  usePhase3TunnelBenchmark(ready);
  useM2SafeWriteBenchmark(ready);
  useM2LocalSafeWriteBenchmark(ready);
  useM2NativeCloseBenchmark(ready);
}
