import type { AgentCode } from "../../ui/types.ts";

export interface AgentRegistryEntry {
  code: AgentCode;
  name: string;
  commands: readonly string[];
  shellTitleFragments: readonly string[];
}

export const AGENT_REGISTRY: readonly AgentRegistryEntry[] = [
  { code: "CC", name: "Claude Code", commands: ["claude"], shellTitleFragments: ["claude code", "claude"] },
  { code: "CX", name: "Codex", commands: ["codex"], shellTitleFragments: ["codex"] },
  { code: "AM", name: "Amp", commands: ["amp", "ampcode"], shellTitleFragments: ["ampcode", "amp"] },
  { code: "GM", name: "Gemini", commands: ["gemini"], shellTitleFragments: ["gemini"] },
  { code: "CP", name: "Copilot", commands: ["copilot"], shellTitleFragments: ["copilot"] },
  { code: "CR", name: "Cursor", commands: ["agent"], shellTitleFragments: ["cursor"] },
  { code: "DR", name: "Droid", commands: ["droid"], shellTitleFragments: ["droid"] },
  { code: "OC", name: "OpenCode", commands: ["opencode"], shellTitleFragments: ["opencode"] },
  { code: "PI", name: "Pi", commands: ["pi"], shellTitleFragments: ["pi"] },
  { code: "AG", name: "Auggie", commands: ["auggie"], shellTitleFragments: ["auggie"] },
  { code: "DV", name: "Devin", commands: ["devin"], shellTitleFragments: ["devin"] },
] as const;

export const AGENT_NAMES: Record<AgentCode, string> = Object.fromEntries(
  AGENT_REGISTRY.map((agent) => [agent.code, agent.name]),
) as Record<AgentCode, string>;

export const AGENT_COMMANDS: Record<string, AgentCode> = Object.fromEntries(
  AGENT_REGISTRY.flatMap((agent) => agent.commands.map((command) => [command, agent.code])),
) as Record<string, AgentCode>;

export const AGENT_CODES = new Set<AgentCode>(AGENT_REGISTRY.map((agent) => agent.code));

export const AGENT_SHELL_TITLE_FRAGMENTS = AGENT_REGISTRY
  .flatMap((agent) => agent.shellTitleFragments)
  .map((fragment) => fragment.trim().toLowerCase());
