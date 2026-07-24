import type { AgentCode, Session, TerminalProgress } from "../../../ui/types.ts";
import { AGENT_NAMES, isPromptLikeShellTitle } from "../../../ui/types.ts";
import { initialAgentActivity, isAgentShellTitle } from "./agent-lifecycle.ts";
import { t } from "../../i18n/core.ts";

export interface SessionLifecycleUpdate {
  patch: Partial<Session>;
  refreshGit?: boolean;
}

export function agentDetectedUpdate(
  session: Session | undefined,
  agent: AgentCode,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session || session.agent === agent) return null;
  return {
    patch: {
      agent,
      agentActivity: initialAgentActivity(agent),
      title: AGENT_NAMES[agent] ?? agent,
      runState: "idle",
      startedAt: now,
      completedAt: undefined,
      lastCommand: undefined,
      shellTitle: undefined,
      suppressShellTitle: false,
      terminalProgress: undefined,
    },
  };
}

export function agentReadyUpdate(
  session: Session | undefined,
  isActive: boolean,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session?.agent || session.agentActivity === "idle") return null;
  const completedTurn = session.agentActivity === "running"
    || session.agentActivity === "waiting_confirmation";
  return {
    patch: {
      agentActivity: "idle",
      runState: "idle",
      ...(completedTurn ? { completedAt: now } : {}),
      ...(completedTurn && !isActive ? { unread: true } : {}),
    },
    ...(completedTurn ? { refreshGit: true } : {}),
  };
}

export function agentWaitingConfirmationUpdate(
  session: Session | undefined,
  isActive: boolean,
): SessionLifecycleUpdate | null {
  if (!session?.agent || session.agentActivity !== "running") return null;
  return {
    patch: {
      agentActivity: "waiting_confirmation",
      runState: "idle",
      completedAt: undefined,
      terminalProgress: undefined,
      unread: !isActive,
    },
  };
}

export function agentBusyUpdate(
  session: Session | undefined,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session?.agent || session.agentActivity === "running") return null;
  return {
    patch: {
      agentActivity: "running",
      runState: "idle",
      startedAt: now,
      completedAt: undefined,
      unread: false,
    },
  };
}

export function agentExitedUpdate(
  session: Session | undefined,
  exitCode: number,
  isActive: boolean,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session) return null;
  return {
    patch: {
      agent: undefined,
      agentActivity: undefined,
      title: t("session.default_title"),
      lastCommand: undefined,
      lastExitCode: exitCode,
      shellTitle: undefined,
      suppressShellTitle: true,
      terminalProgress: undefined,
      ...(session.agentActivity === "starting" && exitCode !== 0 ? { agentResume: undefined } : {}),
      runState: exitCode === 0 ? "done" : "failed",
      completedAt: now,
      ...(!isActive ? { unread: true } : {}),
    },
    refreshGit: true,
  };
}

export function commandDetectedUpdate(
  session: Session | undefined,
  command: string,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (session?.agent || isPromptLikeShellTitle(command)) return null;
  return {
    patch: {
      lastCommand: command,
      runState: "running",
      startedAt: now,
      suppressShellTitle: false,
      terminalProgress: undefined,
    },
  };
}

export function commandFinishedUpdate(
  session: Session | undefined,
  exitCode: number,
  isActive: boolean,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session) return null;
  if (session.agent || !session.lastCommand) {
    return { patch: { lastExitCode: exitCode }, refreshGit: true };
  }
  return {
    patch: {
      lastExitCode: exitCode,
      runState: exitCode === 0 ? "done" : "failed",
      completedAt: now,
      ...(!isActive ? { unread: true } : {}),
    },
    refreshGit: true,
  };
}

export function terminalExitedUpdate(
  session: Session | undefined,
  exitCode: number,
  isActive: boolean,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session) return null;
  const wasAgent = Boolean(session.agent);
  return {
    patch: {
      // A PTY id is a live backend handle, not durable session identity. Once
      // the process exits, every Files/Git/SFTP consumer must stop routing
      // requests through it, even if the logical session remains visible.
      ptyId: undefined,
      transportGeneration: undefined,
      agent: undefined,
      agentActivity: undefined,
      ...(wasAgent ? { title: t("session.default_title"), lastCommand: undefined } : {}),
      lastExitCode: exitCode,
      terminalProgress: undefined,
      runState: exitCode === 0 ? "done" : "failed",
      completedAt: now,
      shellTitle: undefined,
      suppressShellTitle: true,
      ...(!isActive ? { unread: true } : {}),
    },
    refreshGit: true,
  };
}

export function cwdChangedUpdate(
  session: Session | undefined,
  cwd: string,
): SessionLifecycleUpdate | null {
  if (!session || session.dir === cwd) return null;
  const lastCommand = session.lastCommand?.trim() ?? "";
  return {
    patch: {
      dir: cwd,
      branch: "",
      gitState: "unknown",
      changes: undefined,
      shellTitle: undefined,
      suppressShellTitle: false,
      ...(/^(?:cd|pushd|popd)(?:\s|$)/.test(lastCommand)
        ? { lastCommand: undefined }
        : {}),
    },
    refreshGit: true,
  };
}

export function shellTitleUpdate(
  session: Session | undefined,
  title: string,
): SessionLifecycleUpdate | null {
  // Agent sessions do not get a shellTitle: agents like Claude Code only emit an
  // OSC title equal to their own name ("✳ Claude Code"), which carries no
  // information beyond the icon/name we already show. The live "what is it
  // doing" signal comes from agentActivity instead (see deriveTitle).
  if (
    session?.agent
    || session?.suppressShellTitle
    || isAgentShellTitle(title)
    || isPromptLikeShellTitle(title)
  ) {
    return null;
  }
  return { patch: { shellTitle: title } };
}

export function terminalProgressUpdate(
  session: Session | undefined,
  progress: TerminalProgress | undefined,
): SessionLifecycleUpdate | null {
  if (!session) return null;
  const previousValue = session.terminalProgress?.value;
  const nextProgress = progress && progress.value === undefined && progress.state !== "indeterminate" && previousValue !== undefined
    ? { ...progress, value: previousValue }
    : progress;
  // Short-circuit when nothing actually changed. This runs on the PTY output
  // hot path, so returning a patch for an identical progress would needlessly
  // rebuild the sessions array and re-render subscribers every frame.
  const current = session.terminalProgress;
  if (current === nextProgress) return null;
  if (
    current && nextProgress
    && current.value === nextProgress.value
    && current.state === nextProgress.state
  ) {
    return null;
  }
  if (!current && !nextProgress) return null;
  return { patch: { terminalProgress: nextProgress } };
}
