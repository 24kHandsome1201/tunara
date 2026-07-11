import type { AgentResumeIntent } from "@/ui/types";
import type { AgentCode } from "@/ui/types";

const NON_INTERACTIVE_FLAGS: Record<"CC" | "CX", ReadonlySet<string>> = {
  CC: new Set(["--help", "-h", "--version", "-v", "--print", "-p"]),
  CX: new Set(["--help", "-h", "--version", "-V"]),
};

const NON_INTERACTIVE_SUBCOMMANDS: Record<"CC" | "CX", ReadonlySet<string>> = {
  CC: new Set(["auth", "doctor", "install", "mcp", "plugin", "plugins", "setup-token", "update"]),
  CX: new Set([
    "app-server",
    "apply",
    "cloud",
    "completion",
    "debug",
    "exec",
    "features",
    "login",
    "logout",
    "mcp",
    "sandbox",
  ]),
};

const FLAGS_WITH_VALUES = new Set([
  "--add-dir",
  "--agent",
  "--allowedTools",
  "--allowed-tools",
  "--append-system-prompt",
  "--ask-for-approval",
  "--cd",
  "--config",
  "--disallowedTools",
  "--disallowed-tools",
  "--fallback-model",
  "--json-schema",
  "--mcp-config",
  "--model",
  "--output-format",
  "--permission-mode",
  "--plugin-dir",
  "--profile",
  "--sandbox",
  "--settings",
  "--system-prompt",
  "-a",
  "-c",
  "-m",
  "-p",
  "-s",
]);

function commandArgs(command: string, executable: string): string[] | null {
  const tokens = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executableIndex = tokens.findIndex((token) => {
    const unquoted = token.replace(/^["']|["']$/g, "");
    return unquoted.split("/").pop() === executable;
  });
  return executableIndex < 0 ? null : tokens.slice(executableIndex + 1);
}

/**
 * Whether a detected invocation represents an interactive session worth
 * showing as resumable. Version/help/auth/exec-style utility commands still
 * start the same binary, but manufacturing a resume card for them is wrong.
 */
export function isResumableAgentInvocation(agent: AgentCode, command: string): boolean {
  if (agent !== "CC" && agent !== "CX") return false;
  const executable = agent === "CC" ? "claude" : "codex";
  const args = commandArgs(command, executable);
  if (!args) return true;
  if (args.some((token) => NON_INTERACTIVE_FLAGS[agent].has(token))) return false;

  let firstPositional: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      firstPositional = args[index + 1];
      break;
    }
    if (token.startsWith("--") && token.includes("=")) continue;
    if (token.startsWith("-")) {
      if (FLAGS_WITH_VALUES.has(token)) index += 1;
      continue;
    }
    firstPositional = token;
    break;
  }
  return !firstPositional || !NON_INTERACTIVE_SUBCOMMANDS[agent].has(firstPositional);
}

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

export function reconcileAgentResumeIntent(
  existing: AgentResumeIntent | undefined,
  detectedAgent: AgentCode,
  next: AgentResumeIntent | undefined,
): AgentResumeIntent | undefined {
  if (next) return next;
  return existing?.agent === detectedAgent ? existing : undefined;
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
    return "claude --resume";
  }
  if (intent.agent === "CX") {
    if (intent.resumeId && intent.confidence === "exact") {
      return `codex resume ${shellQuoteToken(intent.resumeId)}`;
    }
    if (intent.confidence === "continue") return "codex resume --last";
    return "codex resume";
  }
  return null;
}
