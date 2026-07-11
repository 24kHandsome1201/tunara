import type { AgentCode, AgentResumeIntent, Session } from "@/ui/types";
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

function firstPositionalIndex(args: string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const token = unquoteToken(args[index]);
    if (token === "--") return index + 1;
    if (token.startsWith("--") && token.includes("=")) continue;
    if (token.startsWith("-")) {
      if (FLAGS_WITH_VALUES.has(token)) index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function normalizeResumeId(value: string): string | null {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/.test(value) ? value : null;
}

/** Parse only real Claude/Codex resume CLI positions, never prompt text. */
export function parseResumeId(command: string): string | null {
  const agent = detectAgentCommand(command);
  if (agent === "CC") {
    const args = commandArgs(command, "claude") ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const token = unquoteToken(args[index]);
      if (token.startsWith("--resume=")) {
        return normalizeResumeId(token.slice("--resume=".length));
      }
      if (token === "--resume") {
        return normalizeResumeId(unquoteToken(args[index + 1] ?? ""));
      }
    }
    return null;
  }
  if (agent === "CX") {
    const args = commandArgs(command, "codex") ?? [];
    const resumeIndex = firstPositionalIndex(args);
    if (resumeIndex < 0 || unquoteToken(args[resumeIndex]) !== "resume") return null;
    return normalizeResumeId(unquoteToken(args[resumeIndex + 1] ?? ""));
  }
  return null;
}

export function hasContinueFlag(command: string): boolean {
  const agent = detectAgentCommand(command);
  if (agent === "CC") {
    const args = commandArgs(command, "claude") ?? [];
    return args.some((token) => unquoteToken(token) === "--continue");
  }
  if (agent === "CX") {
    const args = commandArgs(command, "codex") ?? [];
    const resumeIndex = firstPositionalIndex(args);
    return resumeIndex >= 0
      && unquoteToken(args[resumeIndex]) === "resume"
      && unquoteToken(args[resumeIndex + 1] ?? "") === "--last";
  }
  return false;
}

export function reconcileAgentResumeIntent(
  existing: AgentResumeIntent | undefined,
  detectedAgent: AgentCode,
  next: AgentResumeIntent | undefined,
): AgentResumeIntent | undefined {
  if (next) return next;
  return existing?.agent === detectedAgent ? existing : undefined;
}

/** Build resume provenance for one detected agent process generation. */
export function buildAgentResumeIntent(
  session: Session | undefined,
  agent: AgentCode,
  command?: string,
  now = Date.now(),
): AgentResumeIntent | undefined {
  if (!session) return undefined;

  const existing = session.agentResume;
  const explicitCommand = command?.trim() ?? "";
  const sameRunningAgent = session.agent === agent;
  if (sameRunningAgent && !explicitCommand) return undefined;

  const normalized = explicitCommand || existing?.command || session.lastCommand?.trim() || "";
  if (!normalized || !isResumableAgentInvocation(agent, normalized)) return undefined;

  const newGeneration = !sameRunningAgent;
  const preserveActiveExact = !newGeneration
    && existing?.agent === agent
    && existing.confidence === "exact"
    && Boolean(existing.resumeId);
  const parsedResumeId = explicitCommand ? parseResumeId(normalized) : null;
  const resumeId = preserveActiveExact ? existing.resumeId : parsedResumeId ?? undefined;
  const continueMatch = explicitCommand ? hasContinueFlag(normalized) : false;
  const next: AgentResumeIntent = {
    agent,
    command: normalized,
    cwd: newGeneration ? session.dir : existing?.cwd ?? session.dir,
    ...(resumeId ? { resumeId } : {}),
    lastSeenAt: now,
    confidence: resumeId ? "exact" : continueMatch ? "continue" : "unknown",
  };
  if (
    existing?.agent === next.agent
    && existing.command === next.command
    && existing.cwd === next.cwd
    && existing.resumeId === next.resumeId
    && existing.confidence === next.confidence
  ) {
    return undefined;
  }
  return next;
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

function shellQuoteCwd(cwd: string): string {
  if (cwd === "~") return '"$HOME"';
  if (cwd.startsWith("~/")) return `"$HOME"/${shellQuoteToken(cwd.slice(2))}`;
  return shellQuoteToken(cwd);
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

export function buildAgentResumeLaunchCommand(
  intent: AgentResumeIntent | undefined,
  currentCwd: string,
): string | null {
  const command = buildAgentResumeCommand(intent);
  if (!command || !intent) return command;
  const resumeCwd = intent.cwd.trim();
  if (!resumeCwd || resumeCwd === currentCwd) return command;
  return `cd -- ${shellQuoteCwd(resumeCwd)} && ${command}`;
}
