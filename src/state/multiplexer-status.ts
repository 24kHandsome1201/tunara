import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  STATUS_MULTIPLEXERS,
  sameMultiplexerSummary,
  summarizeMultiplexerPanes,
  type MultiplexerStatus,
  type MultiplexerStatusSummary,
  type StatusMultiplexer,
} from "@/modules/session/multiplexer-status";

const POLL_MS = 3000;

interface MultiplexerStatusState {
  summaries: Partial<Record<StatusMultiplexer, MultiplexerStatusSummary>>;
  setSummary: (kind: StatusMultiplexer, summary: MultiplexerStatusSummary | null) => void;
}

export const useMultiplexerStatusStore = create<MultiplexerStatusState>((set, get) => ({
  summaries: {},
  setSummary: (kind, summary) => {
    const current = get().summaries;
    if (sameMultiplexerSummary(current[kind], summary)) return;
    const next = { ...current };
    if (summary) next[kind] = summary;
    else delete next[kind];
    set({ summaries: next });
  },
}));

export function useMultiplexerSummary(kind: StatusMultiplexer | null): MultiplexerStatusSummary | null {
  return useMultiplexerStatusStore((s) => (kind ? s.summaries[kind] ?? null : null));
}

export async function fetchMultiplexerSummary(kind: StatusMultiplexer): Promise<MultiplexerStatusSummary | null> {
  const status = await invoke<MultiplexerStatus | null>("multiplexer_status", { kind });
  return status && status.kind === kind ? summarizeMultiplexerPanes(status.panes) : null;
}

/**
 * Polls each active multiplexer's read-only status adapter; summaries of
 * inactive kinds are cleared.
 */
export function useMultiplexerStatusPolling(active: readonly StatusMultiplexer[]) {
  const key = STATUS_MULTIPLEXERS.filter((kind) => active.includes(kind)).join(",");
  useEffect(() => {
    const kinds = (key ? key.split(",") : []) as StatusMultiplexer[];
    const { setSummary } = useMultiplexerStatusStore.getState();
    for (const kind of STATUS_MULTIPLEXERS) {
      if (!kinds.includes(kind)) setSummary(kind, null);
    }
    let cancelled = false;
    const timers = new Map<StatusMultiplexer, ReturnType<typeof setTimeout>>();
    const poll = async (kind: StatusMultiplexer) => {
      try {
        const summary = await fetchMultiplexerSummary(kind);
        if (!cancelled) setSummary(kind, summary);
      } catch {
        if (!cancelled) setSummary(kind, null);
      }
      if (!cancelled) timers.set(kind, setTimeout(() => void poll(kind), POLL_MS));
    };
    for (const kind of kinds) void poll(kind);
    return () => {
      cancelled = true;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [key]);
}
