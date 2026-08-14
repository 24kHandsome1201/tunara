import { useEffect } from "react";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { useDockBadge } from "./useDockBadge";
import { useGlobalShortcut } from "./useGlobalShortcut";
import { useInit } from "./useInit";
import { useKeybindings } from "./useKeybindings";
import { useM2LocalSafeWriteBenchmark } from "./useM2LocalSafeWriteBenchmark";
import { useM2NativeCloseBenchmark } from "./useM2NativeCloseBenchmark";
import { useM2SafeWriteBenchmark } from "./useM2SafeWriteBenchmark";
import { usePhase3CaptureBenchmark } from "./usePhase3CaptureBenchmark";
import { usePhase3RestartBenchmark } from "./usePhase3RestartBenchmark";
import { usePhase3TelemetryBenchmark } from "./usePhase3TelemetryBenchmark";
import { usePhase3TunnelBenchmark } from "./usePhase3TunnelBenchmark";
import { usePresentationModeContextMenuGuard } from "./usePresentationModeContextMenuGuard";
import { useTerminalBenchmark } from "./useTerminalBenchmark";
import { useTheme } from "./useTheme";
import { useUpdateReminder } from "./useUpdateReminder";

/** Mounts app-wide lifecycle services once, outside the shell layout markup. */
export function useAppServices(ready: boolean, purePresentation: boolean): void {
  useInit();
  useTheme();
  useKeybindings();
  useDockBadge();
  useGlobalShortcut();
  useUpdateReminder(ready);

  // Benchmark hooks are inert in regular builds and activate only for their
  // explicit VITE_TUNARA_BENCHMARK_VARIANT. Keep the harness grouped here so
  // App.tsx remains the production shell owner rather than a test runner.
  useTerminalBenchmark(ready);
  usePhase3TelemetryBenchmark(ready);
  usePhase3RestartBenchmark(ready);
  usePhase3TunnelBenchmark(ready);
  usePhase3CaptureBenchmark(ready);
  useM2SafeWriteBenchmark(ready);
  useM2LocalSafeWriteBenchmark(ready);
  useM2NativeCloseBenchmark(ready);

  usePresentationModeContextMenuGuard(purePresentation);

  useEffect(() => {
    void useTransferStore.getState().loadJournal();
  }, []);
}
