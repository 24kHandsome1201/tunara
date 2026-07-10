import type { Terminal } from "@xterm/xterm";
import type { Session } from "../../../ui/types.ts";
import {
  CODEX_SCREEN_STATE_RECENT_LINE_LIMIT,
  detectCodexScreenState,
} from "./agent-lifecycle.ts";
import { getTerminalTailText } from "./terminal-buffer-read.ts";

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
  let stateTimer: ReturnType<typeof setTimeout> | null = null;

  const reset = () => {
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
  };

  const schedule = () => {
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      stateTimer = null;
      if (!isTrackingCodex()) return;

      const current = getCurrentSession();
      if (current?.agent !== "CX") return;

      const tail = getTerminalTailText(terminal, CODEX_SCREEN_STATE_RECENT_LINE_LIMIT);
      const screenState = detectCodexScreenState(tail);
      if (
        screenState === "busy" &&
        current.agentActivity !== "running"
      ) {
        onBusy(getSessionId());
      } else if (screenState === "ready" && current.agentActivity !== "idle") {
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
