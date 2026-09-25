import type { TerminalMultiplexer } from "./terminal-multiplexer.ts";

/** Multiplexers with a read-only status adapter (`multiplexer_status` IPC). */
export type StatusMultiplexer = "herdr" | "tmux" | "zellij";

/**
 * HerdR reports lifecycle states itself; tmux/Zellij only expose the pane's
 * foreground process, so a registry-matched agent there is `running`.
 */
export type MultiplexerAgentStatus = "idle" | "working" | "blocked" | "done" | "running" | "unknown";

export interface MultiplexerPaneStatus {
  paneId: string;
  sessionId?: string | null;
  windowId?: string | null;
  focused: boolean;
  agent: string | null;
  agentStatus: MultiplexerAgentStatus;
  cwd: string | null;
}

export interface MultiplexerStatus {
  kind: StatusMultiplexer;
  panes: MultiplexerPaneStatus[];
}

export interface MultiplexerStatusSummary {
  blocked: number;
  working: number;
  running: number;
  done: number;
  focusedCwd: string | null;
}

export function statusMultiplexer(multiplexer: TerminalMultiplexer | null): StatusMultiplexer | null {
  return multiplexer === "herdr" || multiplexer === "tmux" || multiplexer === "zellij" ? multiplexer : null;
}

/** Only panes with a detected agent count toward the lifecycle totals. */
export function summarizeMultiplexerPanes(panes: readonly MultiplexerPaneStatus[]): MultiplexerStatusSummary {
  const summary: MultiplexerStatusSummary = { blocked: 0, working: 0, running: 0, done: 0, focusedCwd: null };
  for (const pane of panes) {
    if (pane.focused && summary.focusedCwd === null) summary.focusedCwd = pane.cwd;
    if (!pane.agent) continue;
    if (pane.agentStatus === "blocked") summary.blocked += 1;
    else if (pane.agentStatus === "working") summary.working += 1;
    else if (pane.agentStatus === "running") summary.running += 1;
    else if (pane.agentStatus === "done") summary.done += 1;
  }
  return summary;
}

export function sameMultiplexerSummary(a: MultiplexerStatusSummary | null | undefined, b: MultiplexerStatusSummary | null | undefined): boolean {
  if (a === b || (!a && !b)) return true;
  return !!a && !!b && a.blocked === b.blocked && a.working === b.working && a.running === b.running
    && a.done === b.done && a.focusedCwd === b.focusedCwd;
}
