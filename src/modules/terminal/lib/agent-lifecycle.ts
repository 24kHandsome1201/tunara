import type { AgentActivity, AgentCode, RunState, Session } from "@/ui/types";
import { AGENT_NAMES } from "@/ui/types";
import { cleanTerminalText } from "./terminal-utils";

export const HOOK_READY_AGENTS = new Set<AgentCode>(["CC", "DR"]);
export const PROMPT_READY_AGENTS = new Set<AgentCode>(["CX"]);

const AGENT_COMMANDS: Record<string, AgentCode> = {
  claude: "CC",
  codex: "CX",
  amp: "AM",
  ampcode: "AM",
  gemini: "GM",
  copilot: "CP",
  agent: "CR",
  droid: "DR",
  opencode: "OC",
  pi: "PI",
  auggie: "AG",
  devin: "DV",
};

const AGENT_SHELL_TITLE_ALIASES = new Set(
  [
    ...Object.values(AGENT_NAMES),
    ...Object.keys(AGENT_COMMANDS),
  ].map((title) => title.trim().toLowerCase()),
);

const AGENT_SHELL_TITLE_FRAGMENTS = [
  "claude code",
  "claude",
  "codex",
  "ampcode",
  "gemini",
  "copilot",
  "droid",
  "opencode",
  "auggie",
  "devin",
];

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

function isCodexPromptLine(line: string): boolean {
  return /^\s*›(?:\s|$)/.test(line);
}

function hasCodexBusyIndicator(text: string): boolean {
  return /\bWorking\b/i.test(text)
    || /esc to interrupt/i.test(text)
    || /Pursuing goal/i.test(text)
    || /background terminal running/i.test(text);
}

export function detectCodexScreenState(text: string): AgentScreenState {
  const lines = cleanTerminalText(text)
    .split("\n")
    .map((line) => line.trimEnd());
  const recent = lines.slice(-8);
  let promptIndex = -1;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (isCodexPromptLine(recent[i])) {
      promptIndex = i;
      break;
    }
  }

  const afterPrompt = promptIndex >= 0 ? recent.slice(promptIndex + 1) : [];
  const afterPromptText = afterPrompt.join("\n");
  if (promptIndex >= 0) {
    if (hasCodexBusyIndicator(afterPromptText)) return "busy";
    if (afterPrompt.length <= 4) return "ready";
  }

  const recentText = recent.join("\n");
  if (hasCodexBusyIndicator(recentText)) {
    return "busy";
  }

  return null;
}
