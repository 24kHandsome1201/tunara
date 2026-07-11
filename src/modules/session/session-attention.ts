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
