import { type Terminal } from "@xterm/xterm";
import { type Session } from "../../../ui/types.ts";
import {
  CODEX_SCREEN_STATE_RECENT_LINE_LIMIT,
  detectCodexScreenState,
} from "./agent-lifecycle.ts";
import { getTerminalTailText } from "./terminal-buffer-read.ts";

export const CODEX_DATA_BURST_BUSY_THRESHOLD = 3;
export const CODEX_STATE_CHECK_DELAY_MS = 500;

interface CodexScreenStateTrackerOptions {
  terminal: Terminal;
  getSessionId: () => string;
  getCurrentSession: () => Session | undefined;
  isTrackingCodex: () => boolean;
  onBusy: (sessionId: string) => void;
  onReady: (sessionId: string) => void;
}

export interface CodexScreenStateTracker {
  schedule: () => void;
  reset: () => void;
  dispose: () => void;
}

export function createCodexScreenStateTracker({
  terminal,
  getSessionId,
  getCurrentSession,
  isTrackingCodex,
  onBusy,
  onReady,
}: CodexScreenStateTrackerOptions): CodexScreenStateTracker {
  let dataBurstCount = 0;
  let stateTimer: ReturnType<typeof setTimeout> | null = null;

  const reset = () => {
    dataBurstCount = 0;
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
  };

  const schedule = () => {
    dataBurstCount += 1;
    const session = getCurrentSession();
    const sessionId = getSessionId();
    if (
      session?.agent === "CX" &&
      session.agentActivity !== "running" &&
      dataBurstCount >= CODEX_DATA_BURST_BUSY_THRESHOLD
    ) {
      onBusy(sessionId);
    }

    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      stateTimer = null;
      dataBurstCount = 0;
      if (!isTrackingCodex()) return;

      const current = getCurrentSession();
      if (current?.agent !== "CX") return;

      const tail = getTerminalTailText(terminal, CODEX_SCREEN_STATE_RECENT_LINE_LIMIT);
      if (detectCodexScreenState(tail) === "ready" && current.agentActivity !== "idle") {
        onReady(getSessionId());
      }
    }, CODEX_STATE_CHECK_DELAY_MS);
  };

  return {
    schedule,
    reset,
    dispose: reset,
  };
}
