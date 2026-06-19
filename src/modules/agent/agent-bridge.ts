// Agent 前端桥（实施文档 §4.3）
//
// Tauri Channel 封装：spawnAgent / cancelAgent / preflightAgent。
// 与后端 agent/mod.rs 的 invoke 契约一一对应。

import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentEvent, AgentCode } from "@/ui/types";

export async function spawnAgent(
  agent: AgentCode,
  prompt: string,
  cwd: string,
  resume: string | undefined,
  onEvent: (e: AgentEvent) => void,
): Promise<number> {
  const ch = new Channel<AgentEvent>();
  ch.onmessage = onEvent;
  return invoke<number>("agent_spawn", {
    agent,
    prompt,
    cwd,
    resume: resume ?? null,
    onEvent: ch,
  });
}

export function cancelAgent(id: number): Promise<void> {
  return invoke("agent_cancel", { id });
}

export interface Preflight {
  installed: boolean;
  loggedIn: boolean;
  hint?: string;
}

export function preflightAgent(agent: string): Promise<Preflight> {
  return invoke<Preflight>("agent_preflight", { agent });
}

export function getMaxConcurrent(): Promise<number> {
  return invoke<number>("agent_max_concurrent");
}

export interface AgentRunDelta {
  agentOnly: string[];
  preExisting: string[];
  conflicted: string[];
}

export function discardAgentChanges(id: number): Promise<AgentRunDelta> {
  return invoke<AgentRunDelta>("agent_discard_changes", { id });
}

export type ResolveSource = "userOverride" | "loginShellPath" | "systemPath" | "notFound";

export interface ResolvedCommand {
  name: string;
  path: string | null;
  source: ResolveSource;
}

export function resolveAllBins(): Promise<ResolvedCommand[]> {
  return invoke<ResolvedCommand[]>("resolve_all_bins");
}
