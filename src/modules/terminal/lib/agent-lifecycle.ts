import type { AgentActivity, AgentCode, RunState, Session } from "../../../ui/types.ts";
import { AGENT_CODES, AGENT_COMMANDS, AGENT_NAMES, AGENT_SHELL_TITLE_FRAGMENTS, agentCodeForCommand } from "../../agent/registry.ts";
import { cleanTerminalLines, cleanTerminalText } from "./terminal-utils.ts";

export const HOOK_READY_AGENTS = new Set<AgentCode>(["CC", "DR"]);
export const PROMPT_READY_AGENTS = new Set<AgentCode>(["CX"]);

export type AgentLifecycleEventName = "start" | "busy" | "idle" | "stop" | "exit";

export interface AgentLifecycleEvent {
  event: AgentLifecycleEventName;
  session: string;
  agent: AgentCode;
  code?: number;
  agentSessionId?: string;
}

export interface AgentHookEvent {
  event: AgentLifecycleEventName;
  session: string;
  agent: AgentCode;
  code?: number;
  agentSessionId?: string;
}

const AGENT_LIFECYCLE_OSC_PREFIXES = new Set(["tunara-agent", "conduit-agent"]);

const AGENT_SHELL_TITLE_ALIASES = new Set(
  [
    ...Object.values(AGENT_NAMES),
    ...Object.keys(AGENT_COMMANDS),
  ].map((title) => title.trim().toLowerCase()),
);

export function isAgentCode(value: string): value is AgentCode {
  return AGENT_CODES.has(value as AgentCode);
}

export function detectAgentCommand(commandLine: string): AgentCode | null {
  const cmd = cleanTerminalText(commandLine).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return agentCodeForCommand(cmd);
}

export function isAgentShellTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return AGENT_SHELL_TITLE_ALIASES.has(normalized)
    || AGENT_SHELL_TITLE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function initialAgentActivity(agent: AgentCode): AgentActivity {
  if (HOOK_READY_AGENTS.has(agent)) return "starting";
  if (PROMPT_READY_AGENTS.has(agent)) return "idle";
  return "running";
}

export function shouldUseStartupQuietReadyFallback(
  agent: AgentCode | null | undefined,
  activity: AgentActivity | undefined,
): boolean {
  return !!agent
    && HOOK_READY_AGENTS.has(agent)
    && activity === "starting";
}

export function isAgentActivityBusy(activity?: AgentActivity): boolean {
  return activity === "starting" || activity === "running";
}

export function isSessionBusy(session: Session): boolean {
  return session.agent
    ? isAgentActivityBusy(session.agentActivity)
    : session.runState === "running";
}

export function sessionDisplayRunState(session: Session): RunState {
  if (!session.agent) return session.runState;
  if (isAgentActivityBusy(session.agentActivity)) return "running";
  return session.completedAt ? "done" : "idle";
}

export type AgentScreenState = "ready" | "busy" | null;

export const CODEX_PROMPT_PATTERN = /^\s*›(?:\s|$)/;
export const CODEX_BUSY_INDICATORS = [
  /\bWorking\b/i,
  /esc to interrupt/i,
  /Pursuing goal/i,
  /background terminal running/i,
] as const;
export const CODEX_SCREEN_STATE_RECENT_LINE_LIMIT = 12;

function isCodexPromptLine(line: string): boolean {
  return CODEX_PROMPT_PATTERN.test(line);
}

function hasCodexBusyIndicator(text: string): boolean {
  return CODEX_BUSY_INDICATORS.some((pattern) => pattern.test(text));
}

export function detectCodexScreenState(text: string): AgentScreenState {
  const lines = cleanTerminalLines(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const recent = lines.slice(-CODEX_SCREEN_STATE_RECENT_LINE_LIMIT);
  let promptIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (isCodexPromptLine(recent[i])) {
      promptIndex = i;
      break;
    }
  }

  if (promptIndex >= 0) {
    const currentTurnText = recent.slice(promptIndex + 1).join("\n");
    return hasCodexBusyIndicator(currentTurnText) ? "busy" : "ready";
  }

  const recentText = recent.join("\n");
  if (hasCodexBusyIndicator(recentText)) {
    return "busy";
  }

  return null;
}

export function parseAgentLifecycleOsc(data: string): AgentLifecycleEvent | null {
  const parts = data.split(";");
  if (parts.length > 6) return null;
  if (!AGENT_LIFECYCLE_OSC_PREFIXES.has(parts[0] ?? "")) return null;

  const event = parts[1] as AgentLifecycleEventName | undefined;
  const session = parts[2] ?? "";
  const agent = parts[3] ?? "";
  const codeText = parts[4] ?? "";
  const agentSessionIdText = parts[5] ?? "";

  if (event !== "start" && event !== "busy" && event !== "idle" && event !== "stop" && event !== "exit") return null;
  if (!session || !isAgentCode(agent)) return null;
  if (event !== "exit" && codeText !== "") return null;

  const parsedCode = /^-?\d+$/.test(codeText) ? Number.parseInt(codeText, 10) : undefined;
  const code = Number.isSafeInteger(parsedCode) ? parsedCode : undefined;
  const agentSessionId = /^[A-Za-z0-9_-]{1,256}$/.test(agentSessionIdText)
    ? agentSessionIdText
    : undefined;
  return {
    event,
    session,
    agent,
    ...(code !== undefined ? { code } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
  };
}

/** Validate the native hook socket payload at the frontend boundary. Tauri's
 * generic type parameter is compile-time only; malformed runtime data must not
 * be allowed to manufacture an AgentCode or a successful exit. */
export function parseAgentHookEvent(value: unknown): AgentHookEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const event = payload.event;
  const session = payload.session;
  const agent = payload.agent;
  const code = payload.code;
  const agentSessionId = payload.agentSessionId;

  if (event !== "start" && event !== "busy" && event !== "idle" && event !== "stop" && event !== "exit") return null;
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(session)) return null;
  if (typeof agent !== "string" || !isAgentCode(agent)) return null;
  if (code != null && (typeof code !== "number" || !Number.isSafeInteger(code))) return null;
  if (event !== "exit" && code != null) return null;

  const cleanAgentSessionId = typeof agentSessionId === "string"
    && /^[A-Za-z0-9_-]{1,256}$/.test(agentSessionId)
    ? agentSessionId
    : undefined;
  return {
    event,
    session,
    agent,
    ...(typeof code === "number" ? { code } : {}),
    ...(cleanAgentSessionId ? { agentSessionId: cleanAgentSessionId } : {}),
  };
}
