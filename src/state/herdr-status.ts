import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  sameHerdrSummary,
  summarizeHerdrPanes,
  type HerdrPaneStatus,
  type HerdrStatusSummary,
} from "@/modules/session/herdr-status";

const POLL_MS = 3000;

interface HerdrStatusState {
  summary: HerdrStatusSummary | null;
  setSummary: (summary: HerdrStatusSummary | null) => void;
}

export const useHerdrStatusStore = create<HerdrStatusState>((set, get) => ({
  summary: null,
  setSummary: (summary) => {
    if (!sameHerdrSummary(get().summary, summary)) set({ summary });
  },
}));

/** Polls the local HerdR server while `active`; clears the summary otherwise. */
export function useHerdrStatusPolling(active: boolean) {
  useEffect(() => {
    const { setSummary } = useHerdrStatusStore.getState();
    if (!active) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await invoke<{ panes: HerdrPaneStatus[] } | null>("herdr_status");
        if (!cancelled) setSummary(status ? summarizeHerdrPanes(status.panes) : null);
      } catch {
        if (!cancelled) setSummary(null);
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
}
