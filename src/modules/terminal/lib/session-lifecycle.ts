import type { AgentCode, Session } from "../../../ui/types.ts";
import { AGENT_NAMES, isPromptLikeShellTitle } from "../../../ui/types.ts";
import { initialAgentActivity, isAgentShellTitle } from "./agent-lifecycle.ts";

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
    },
  };
}

export function agentReadyUpdate(
  session: Session | undefined,
  isActive: boolean,
  now = Date.now(),
): SessionLifecycleUpdate | null {
  if (!session?.agent) return null;
  return {
    patch: {
      agentActivity: "idle",
      runState: "idle",
      completedAt: now,
      ...(!isActive ? { unread: true } : {}),
    },
    refreshGit: true,
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
      title: "终端",
      lastCommand: undefined,
      lastExitCode: exitCode,
      shellTitle: undefined,
      suppressShellTitle: true,
      runState: "idle",
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
    return { patch: { lastExitCode: exitCode } };
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
