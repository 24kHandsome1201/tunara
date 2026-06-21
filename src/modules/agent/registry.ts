import type { AgentCode } from "../../ui/types.ts";
import agentRegistryData from "./registry-data.json" with { type: "json" };

export interface AgentRegistryEntry {
  code: AgentCode;
  name: string;
  commands: readonly string[];
  shellTitleFragments: readonly string[];
  cliBin: string;
}

export const AGENT_REGISTRY = agentRegistryData as unknown as readonly AgentRegistryEntry[];

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
