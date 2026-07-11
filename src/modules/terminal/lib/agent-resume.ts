import type { AgentResumeIntent } from "@/ui/types";
import type { AgentCode } from "@/ui/types";
import { detectAgentCommand } from "./agent-lifecycle.ts";

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

const CLAUDE_RESUME_PERMISSION_MODES = new Set(["default", "plan"]);
const CODEX_RESUME_SANDBOXES = new Set(["read-only", "workspace-write"]);
const CODEX_RESUME_APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);

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

export function resolveAgentResumeSourceCommand(
  agent: AgentCode,
  existing: AgentResumeIntent | undefined,
  lastCommand: string | undefined,
  fallback: string,
): string {
  const existingCommand = existing?.agent === agent ? existing.command.trim() : "";
  if (existingCommand) return existingCommand;
  const detectedCommand = lastCommand?.trim() ?? "";
  return detectedCommand
    && detectAgentCommand(detectedCommand) === agent
    && isResumableAgentInvocation(agent, detectedCommand)
    ? detectedCommand
    : fallback;
}

function shellQuoteToken(token: string): string {
  return /^[A-Za-z0-9._:@%/+=,-]+$/.test(token)
    ? token
    : `'${token.replace(/'/g, "'\\''")}'`;
}

function unquoteToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function allowedOptionValue(
  args: string[],
  names: readonly string[],
  allowed: ReadonlySet<string>,
): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = unquoteToken(args[index]);
    for (const name of names) {
      if (token === name) {
        const value = unquoteToken(args[index + 1] ?? "");
        if (allowed.has(value)) return value;
      } else if (token.startsWith(`${name}=`)) {
        const value = unquoteToken(token.slice(name.length + 1));
        if (allowed.has(value)) return value;
      }
    }
  }
  return null;
}

function resumeSafetyFlags(intent: AgentResumeIntent): string[] {
  if (intent.agent !== "CC" && intent.agent !== "CX") return [];
  const executable = intent.agent === "CC" ? "claude" : "codex";
  const args = commandArgs(intent.command, executable) ?? [];
  if (intent.agent === "CC") {
    const permissionMode = allowedOptionValue(
      args,
      ["--permission-mode"],
      CLAUDE_RESUME_PERMISSION_MODES,
    );
    return permissionMode ? ["--permission-mode", permissionMode] : [];
  }

  const flags: string[] = [];
  const sandbox = allowedOptionValue(
    args,
    ["--sandbox", "-s"],
    CODEX_RESUME_SANDBOXES,
  );
  if (sandbox) flags.push("--sandbox", sandbox);
  const approval = allowedOptionValue(
    args,
    ["--ask-for-approval", "-a"],
    CODEX_RESUME_APPROVAL_POLICIES,
  );
  if (approval) flags.push("--ask-for-approval", approval);
  return flags;
}

function joinCommand(tokens: string[]): string {
  return tokens.map(shellQuoteToken).join(" ");
}

export function buildAgentResumeCommand(intent: AgentResumeIntent | undefined): string | null {
  if (!intent) return null;
  if (intent.agent === "CC") {
    const prefix = ["claude", ...resumeSafetyFlags(intent)];
    if (intent.resumeId && intent.confidence === "exact") {
      return joinCommand([...prefix, "--resume", intent.resumeId]);
    }
    if (intent.confidence === "continue") return joinCommand([...prefix, "--continue"]);
    return joinCommand([...prefix, "--resume"]);
  }
  if (intent.agent === "CX") {
    const prefix = ["codex", ...resumeSafetyFlags(intent), "resume"];
    if (intent.resumeId && intent.confidence === "exact") {
      return joinCommand([...prefix, intent.resumeId]);
    }
    if (intent.confidence === "continue") return joinCommand([...prefix, "--last"]);
    return joinCommand(prefix);
  }
  return null;
}
