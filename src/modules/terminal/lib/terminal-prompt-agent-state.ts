import type { Terminal } from "@xterm/xterm";
import type { Session } from "../../../ui/types.ts";
import {
  detectPromptAgentScreenState,
  PROMPT_AGENT_SCREEN_STATE_RECENT_LINE_LIMIT,
  PROMPT_READY_AGENTS,
} from "./agent-lifecycle.ts";
import { getTerminalTailText } from "./terminal-buffer-read.ts";

export const PROMPT_AGENT_STATE_CHECK_DELAY_MS = 500;

interface PromptAgentScreenStateTrackerOptions {
  terminal: Terminal;
  getSessionId: () => string;
  getCurrentSession: () => Session | undefined;
  onBusy: (sessionId: string) => void;
  onWaitingConfirmation: (sessionId: string) => void;
  onReady: (sessionId: string) => void;
}

export interface PromptAgentScreenStateTracker {
  schedule: () => void;
  reset: () => void;
  dispose: () => void;
}

export function createPromptAgentScreenStateTracker({
  terminal,
  getSessionId,
  getCurrentSession,
  onBusy,
  onWaitingConfirmation,
  onReady,
}: PromptAgentScreenStateTrackerOptions): PromptAgentScreenStateTracker {
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
      const current = getCurrentSession();
      if (!current?.agent || !PROMPT_READY_AGENTS.has(current.agent)) return;

      const tail = getTerminalTailText(terminal, PROMPT_AGENT_SCREEN_STATE_RECENT_LINE_LIMIT);
      const screenState = detectPromptAgentScreenState(current.agent, tail);
      if (screenState === "waiting_confirmation" && current.agentActivity === "running") {
        onWaitingConfirmation(getSessionId());
      } else if (
        screenState === "busy"
        && (current.agentActivity === "idle" || current.agentActivity === "waiting_confirmation")
      ) {
        onBusy(getSessionId());
      } else if (screenState === "ready" && current.agentActivity !== "idle") {
        onReady(getSessionId());
      }
    }, PROMPT_AGENT_STATE_CHECK_DELAY_MS);
  };

  return {
    schedule,
    reset,
    dispose: reset,
  };
}
