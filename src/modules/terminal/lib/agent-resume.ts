import type { AgentResumeIntent } from "@/ui/types";

/**
 * Extracts an explicit resume id from a typed agent command, e.g. the `<id>` in
 * `claude --resume <id>` or `codex resume <id>`. Returns null when the command
 * has no id — including `resume --last` / `--all` / `-r`, where the token after
 * `resume` is a flag, not an id. Mistaking a flag for an id yields a broken
 * resume command, so the leading `-` is explicitly excluded.
 */
export function parseResumeId(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:--resume|resume)\s+(?!-)([^\s]+)/);
  return match ? match[1] : null;
}

export function hasContinueFlag(command: string): boolean {
  return /(?:^|\s)(?:--continue|continue)(?:\s|$)/.test(command);
}

function shellQuoteToken(token: string): string {
  return /^[A-Za-z0-9._:@%/+=,-]+$/.test(token)
    ? token
    : `'${token.replace(/'/g, "'\\''")}'`;
}

export function buildAgentResumeCommand(intent: AgentResumeIntent | undefined): string | null {
  if (!intent) return null;
  if (intent.agent === "CC") {
    if (intent.resumeId && intent.confidence === "exact") {
      return `claude --resume ${shellQuoteToken(intent.resumeId)}`;
    }
    if (intent.confidence === "continue") return "claude --continue";
    return "claude --continue";
  }
  if (intent.agent === "CX") {
    if (intent.resumeId && intent.confidence === "exact") {
      return `codex exec resume ${shellQuoteToken(intent.resumeId)}`;
    }
    if (intent.confidence === "continue") return "codex exec resume --last";
    return "codex exec resume --last";
  }
  return null;
}
