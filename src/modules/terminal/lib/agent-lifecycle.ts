import type { AgentActivity, AgentCode, RunState, Session } from "../../../ui/types.ts";
import { AGENT_CODES, AGENT_COMMANDS, AGENT_NAMES, AGENT_SHELL_TITLE_FRAGMENTS } from "../../agent/registry.ts";
import { cleanTerminalLines, cleanTerminalText } from "./terminal-utils.ts";

export const HOOK_READY_AGENTS = new Set<AgentCode>(["CC", "DR"]);
export const PROMPT_READY_AGENTS = new Set<AgentCode>(["CX"]);

export type AgentLifecycleEventName = "start" | "idle" | "stop" | "exit";

export interface AgentLifecycleEvent {
  event: AgentLifecycleEventName;
  session: string;
  agent: AgentCode;
  code?: number;
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
  return AGENT_COMMANDS[cmd] ?? null;
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
  return isAgentActivityBusy(session.agentActivity) ? "running" : "idle";
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
    const recentJoined = recent.join("\n");
    return hasCodexBusyIndicator(recentJoined) ? "busy" : "ready";
  }

  const recentText = recent.join("\n");
  if (hasCodexBusyIndicator(recentText)) {
    return "busy";
  }

  return null;
}

export function parseAgentLifecycleOsc(data: string): AgentLifecycleEvent | null {
  const parts = data.split(";");
  if (!AGENT_LIFECYCLE_OSC_PREFIXES.has(parts[0] ?? "")) return null;

  const event = parts[1] as AgentLifecycleEventName | undefined;
  const session = parts[2] ?? "";
  const agent = parts[3] ?? "";
  const codeText = parts[4] ?? "";

  if (event !== "start" && event !== "idle" && event !== "stop" && event !== "exit") return null;
  if (!session || !isAgentCode(agent)) return null;

  const code = codeText === "" ? undefined : Number.parseInt(codeText, 10);
  return {
    event,
    session,
    agent,
    ...(Number.isFinite(code) ? { code } : {}),
  };
}
