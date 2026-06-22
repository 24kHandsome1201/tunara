import type { AgentResumeIntent } from "@/ui/types";

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
    return intent.command.startsWith("claude ") || intent.command === "claude" ? intent.command : null;
  }
  if (intent.agent === "CX") {
    if (intent.resumeId && intent.confidence === "exact") {
      return `codex exec resume ${shellQuoteToken(intent.resumeId)}`;
    }
    if (intent.confidence === "continue") return "codex exec resume --last";
    return intent.command.startsWith("codex ") || intent.command === "codex" ? intent.command : null;
  }
  return null;
}
