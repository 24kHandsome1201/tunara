import { useEffect } from "react";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { useDockBadge } from "./useDockBadge";
import { useGlobalShortcut } from "./useGlobalShortcut";
import { useInit } from "./useInit";
import { useKeybindings } from "./useKeybindings";
import { usePresentationModeContextMenuGuard } from "./usePresentationModeContextMenuGuard";
import { useTheme } from "./useTheme";
import { useUpdateReminder } from "./useUpdateReminder";

function useNoopBenchmarks(_ready: boolean): void {}

const useBenchmarks = import.meta.env.VITE_TUNARA_BENCHMARK
  ? (await import("./benchmarks")).useBenchmarks
  : useNoopBenchmarks;

/** Mounts app-wide lifecycle services once, outside the shell layout markup. */
export function useAppServices(ready: boolean, purePresentation: boolean): void {
  useInit();
  useTheme();
  useKeybindings();
  useDockBadge();
  useGlobalShortcut();
  useUpdateReminder(ready);
  useBenchmarks(ready);
  usePresentationModeContextMenuGuard(purePresentation);

  useEffect(() => {
    void useTransferStore.getState().loadJournal();
  }, []);
}
