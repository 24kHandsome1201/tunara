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

function makeRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}

function getOwnRecordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export const AGENT_NAMES = makeRecord(
  AGENT_REGISTRY.map((agent) => [agent.code, agent.name]),
) as Record<AgentCode, string>;

export const AGENT_COMMANDS = makeRecord(
  AGENT_REGISTRY.flatMap((agent) => agent.commands.map((command) => [command, agent.code] as const)),
) as Record<string, AgentCode>;

export const AGENT_CODES = new Set<AgentCode>(AGENT_REGISTRY.map((agent) => agent.code));

export const AGENT_SHELL_TITLE_FRAGMENTS = AGENT_REGISTRY
  .flatMap((agent) => agent.shellTitleFragments)
  .map((fragment) => fragment.trim().toLowerCase());

export function agentCodeForCommand(command: string): AgentCode | null {
  return getOwnRecordValue(AGENT_COMMANDS, command) ?? null;
}

export function agentNameForCode(agent: string): string | undefined {
  return getOwnRecordValue(AGENT_NAMES, agent);
}
