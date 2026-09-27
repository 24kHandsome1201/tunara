import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  sameMultiplexerSummary,
  summarizeMultiplexerPanes,
  type MultiplexerStatus,
  type MultiplexerStatusSummary,
  type StatusMultiplexer,
} from "@/modules/session/multiplexer-status";

const POLL_MS = 3000;

/** One Tunara tab whose foreground multiplexer is polled. */
export interface MultiplexerPollTarget {
  sessionId: string;
  kind: StatusMultiplexer;
  ptyId?: number;
  sessionName?: string | null;
}

interface MultiplexerStatusState {
  /** Keyed by Tunara session id. */
  summaries: Record<string, MultiplexerStatusSummary>;
  setSummary: (sessionId: string, summary: MultiplexerStatusSummary | null) => void;
}

export const useMultiplexerStatusStore = create<MultiplexerStatusState>((set, get) => ({
  summaries: {},
  setSummary: (sessionId, summary) => {
    const current = get().summaries;
    if (sameMultiplexerSummary(current[sessionId], summary)) return;
    const next = { ...current };
    if (summary) next[sessionId] = summary;
    else delete next[sessionId];
    set({ summaries: next });
  },
}));

export function useMultiplexerSummary(sessionId: string | null): MultiplexerStatusSummary | null {
  return useMultiplexerStatusStore((s) => (sessionId ? s.summaries[sessionId] ?? null : null));
}

export async function fetchMultiplexerSummary(target: MultiplexerPollTarget): Promise<MultiplexerStatusSummary | null> {
  const status = await invoke<MultiplexerStatus | null>("multiplexer_status", {
    kind: target.kind,
    ptyId: target.ptyId ?? null,
    sessionName: target.sessionName ?? null,
  });
  return status && status.kind === target.kind ? summarizeMultiplexerPanes(status.panes) : null;
}

/**
 * Polls the read-only status adapter for each tab's own multiplexer session;
 * summaries of tabs no longer polled are cleared.
 */
export function useMultiplexerStatusPolling(targets: readonly MultiplexerPollTarget[]) {
  const key = JSON.stringify(
    [...targets]
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      .map((t) => [t.sessionId, t.kind, t.ptyId ?? null, t.sessionName ?? null]),
  );
  useEffect(() => {
    const polled = (JSON.parse(key) as [string, StatusMultiplexer, number | null, string | null][])
      .map(([sessionId, kind, ptyId, sessionName]): MultiplexerPollTarget => ({
        sessionId, kind, ptyId: ptyId ?? undefined, sessionName,
      }));
    const { setSummary, summaries } = useMultiplexerStatusStore.getState();
    for (const sessionId of Object.keys(summaries)) {
      if (!polled.some((t) => t.sessionId === sessionId)) setSummary(sessionId, null);
    }
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const poll = async (target: MultiplexerPollTarget) => {
      try {
        const summary = await fetchMultiplexerSummary(target);
        if (!cancelled) setSummary(target.sessionId, summary);
      } catch {
        if (!cancelled) setSummary(target.sessionId, null);
      }
      if (!cancelled) {
        const timer = setTimeout(() => { timers.delete(timer); void poll(target); }, POLL_MS);
        timers.add(timer);
      }
    };
    for (const target of polled) void poll(target);
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [key]);
}
