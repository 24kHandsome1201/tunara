import type { Session } from "../../ui/types.ts";
import { isAgentActivityBusy } from "../terminal/lib/agent-lifecycle.ts";
import { buildAgentResumeLaunchCommand } from "../terminal/lib/agent-resume.ts";

export type SessionAttentionKind =
  | "ssh-failed"
  | "ssh-disconnected"
  | "agent-confirmation"
  | "agent-ready"
  | "command-failed";

export interface SessionAttentionItem {
  session: Session;
  kind: SessionAttentionKind;
}

export interface SessionAttentionGroups {
  attention: SessionAttentionItem[];
  running: Session[];
  resumable: Array<{ session: Session; resumeCommand: string }>;
  quiet: Session[];
  total: number;
}

function attentionKind(session: Session): SessionAttentionKind | null {
  if (session.remote && session.connection?.phase === "failed") return "ssh-failed";
  if (session.remote && session.connection?.phase === "disconnected") return "ssh-disconnected";
  if (session.agent && session.agentActivity === "waiting_confirmation") return "agent-confirmation";
  if (session.agent && session.unread && !isAgentActivityBusy(session.agentActivity)) return "agent-ready";
  if (!session.agent && session.unread && session.runState === "failed" && session.lastCommand) {
    return "command-failed";
  }
  return null;
}

/**
 * Derive the sidebar's operational view from canonical session state. Nothing
 * here is persisted, so attention cannot drift away from transport, command,
 * agent, unread, or resume evidence.
 */
export function deriveSessionAttention(sessions: readonly Session[]): SessionAttentionGroups {
  const attention: SessionAttentionItem[] = [];
  const running: Session[] = [];
  const resumable: SessionAttentionGroups["resumable"] = [];
  const quiet: Session[] = [];

  for (const session of sessions) {
    const kind = attentionKind(session);
    if (kind) {
      attention.push({ session, kind });
      continue;
    }
    if (session.runState === "running" || (session.agent && isAgentActivityBusy(session.agentActivity))) {
      running.push(session);
      continue;
    }
    const resumeCommand = !session.agent ? buildAgentResumeLaunchCommand(session.agentResume, session) : null;
    if (resumeCommand) {
      resumable.push({ session, resumeCommand });
      continue;
    }
    quiet.push(session);
  }

  return {
    attention,
    running,
    resumable,
    quiet,
    total: attention.length + running.length + resumable.length,
  };
}

/**
 * Most recently updated attention session, cycling when the caller is already
 * focused on one. Actions only return an id — callers focus, they never run
 * commands.
 */
export function nextAttentionSessionId(
  sessions: readonly Session[],
  activeSessionId: string | null,
): string | null {
  const { attention } = deriveSessionAttention(sessions);
  if (attention.length === 0) return null;
  const ordered = [...attention].sort((left, right) => {
    const delta = right.session.updatedAt - left.session.updatedAt;
    if (delta !== 0) return delta;
    return sessions.indexOf(left.session) - sessions.indexOf(right.session);
  });
  const ids = ordered.map((item) => item.session.id);
  if (!activeSessionId) return ids[0];
  const index = ids.indexOf(activeSessionId);
  if (index === -1) return ids[0];
  return ids[(index + 1) % ids.length];
}
