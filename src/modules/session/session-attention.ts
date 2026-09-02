import type { Session } from "../../ui/types.ts";
import { isAgentActivityBusy } from "../terminal/lib/agent-lifecycle.ts";

export type SessionCue = "needs-you" | "unread";

export type AttentionRowModel =
  | { kind: "needs-you"; count: number }
  | { kind: "running"; count: number }
  | { kind: null; count: 0 };

function connectionNeedsYou(session: Session): boolean {
  const phase = session.connection?.phase;
  return phase === "needsUserAction" || phase === "failed" || phase === "disconnected";
}

function isWaitingForYou(session: Session): boolean {
  if (session.agent && session.agentActivity === "waiting_confirmation") return true;
  if (connectionNeedsYou(session)) return true;
  return session.runState === "failed" && Boolean(session.unread);
}

function isAgentRunning(session: Session): boolean {
  return Boolean(session.agent && isAgentActivityBusy(session.agentActivity));
}

function sessionIndex(sessions: readonly Session[], session: Session): number {
  const index = sessions.indexOf(session);
  return index === -1 ? sessions.findIndex((item) => item.id === session.id) : index;
}

function compareByAttentionTime(
  left: Session,
  right: Session,
  sessions: readonly Session[],
  direction: "fifo" | "recent",
): number {
  const delta = direction === "fifo"
    ? left.updatedAt - right.updatedAt
    : right.updatedAt - left.updatedAt;
  if (delta !== 0) return delta;
  return sessionIndex(sessions, left) - sessionIndex(sessions, right);
}

/**
 * One status slot per session: waiting for confirmation outranks unread
 * output. Running is identity (AgentBadge), not a second cue.
 */
export function sessionCue(session: Session): SessionCue | null {
  if (isWaitingForYou(session)) return "needs-you";
  if (session.unread) return "unread";
  return null;
}

/** Same one-slot rule, rolled up for a directory/host group. */
export function groupCue(sessions: readonly Session[]): SessionCue | null {
  let unread = false;
  for (const session of sessions) {
    const cue = sessionCue(session);
    if (cue === "needs-you") return "needs-you";
    if (cue === "unread") unread = true;
  }
  return unread ? "unread" : null;
}

/** Dock badge N — identical to the sidebar "needs you" count. */
export function dockBadgeCount(sessions: readonly Session[]): number {
  let count = 0;
  for (const session of sessions) {
    if (isWaitingForYou(session)) count += 1;
  }
  return count;
}

/**
 * Sidebar first row: at most one fact. Waiting confirmation uses the
 * terracotta count; otherwise a muted running count; otherwise nothing.
 */
export function deriveAttentionRow(sessions: readonly Session[]): AttentionRowModel {
  const needsYou = dockBadgeCount(sessions);
  if (needsYou > 0) return { kind: "needs-you", count: needsYou };
  let running = 0;
  for (const session of sessions) {
    if (isAgentRunning(session)) running += 1;
  }
  if (running > 0) return { kind: "running", count: running };
  return { kind: null, count: 0 };
}

/**
 * Jump target for the attention row and focusLatestAttention.
 * Earliest waiter (attention time FIFO) wins; if nobody is waiting,
 * the most recently unread session. Actions only return an id.
 */
export function nextAttentionSessionId(
  sessions: readonly Session[],
  _activeSessionId: string | null = null,
): string | null {
  const waiting = sessions.filter(isWaitingForYou);
  if (waiting.length > 0) {
    waiting.sort((left, right) => compareByAttentionTime(left, right, sessions, "fifo"));
    return waiting[0].id;
  }
  const unread = sessions.filter((session) => Boolean(session.unread));
  if (unread.length > 0) {
    unread.sort((left, right) => compareByAttentionTime(left, right, sessions, "recent"));
    return unread[0].id;
  }
  return null;
}
