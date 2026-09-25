export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrPaneStatus {
  paneId: string;
  focused: boolean;
  agent: string | null;
  agentStatus: HerdrAgentStatus;
  cwd: string | null;
}

export interface HerdrStatusSummary {
  blocked: number;
  working: number;
  done: number;
  focusedCwd: string | null;
}

/** Only panes with a detected agent count toward the lifecycle totals. */
export function summarizeHerdrPanes(panes: readonly HerdrPaneStatus[]): HerdrStatusSummary {
  const summary: HerdrStatusSummary = { blocked: 0, working: 0, done: 0, focusedCwd: null };
  for (const pane of panes) {
    if (pane.focused && summary.focusedCwd === null) summary.focusedCwd = pane.cwd;
    if (!pane.agent) continue;
    if (pane.agentStatus === "blocked") summary.blocked += 1;
    else if (pane.agentStatus === "working") summary.working += 1;
    else if (pane.agentStatus === "done") summary.done += 1;
  }
  return summary;
}

export function sameHerdrSummary(a: HerdrStatusSummary | null, b: HerdrStatusSummary | null): boolean {
  return a === b || (!!a && !!b && a.blocked === b.blocked && a.working === b.working && a.done === b.done && a.focusedCwd === b.focusedCwd);
}
