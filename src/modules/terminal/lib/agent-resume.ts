import type { AgentCode, AgentResumeIntent, Session } from "@/ui/types";
import { detectAgentCommand } from "./agent-lifecycle.ts";
import { splitShellCommandSegments, tokenizeShellWords } from "./shell-command.ts";

const NON_INTERACTIVE_FLAGS: Record<"CC" | "CX" | "PI", ReadonlySet<string>> = {
  CC: new Set(["--help", "-h", "--version", "-v", "--print", "-p"]),
  CX: new Set(["--help", "-h", "--version", "-V"]),
  PI: new Set(["--help", "-h", "--version", "-v", "--print", "-p", "--no-session"]),
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
const PI_PACKAGE = /^@earendil-works\/pi-coding-agent(?:@[0-9A-Za-z][0-9A-Za-z._+-]{0,127})?$/;
const PI_PINNED_PACKAGE = /^@earendil-works\/pi-coding-agent@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PI_TIGHTENING_FLAGS = ["--no-extensions", "--no-skills", "--no-context-files", "--no-tools"];
const PI_FLAGS_WITH_VALUES = new Set([
  "--api-key",
  "--mode",
  "--model",
  "--provider",
  "--session-dir",
  "--thinking",
]);

function commandArgs(command: string, executable: string): string[] | null {
  const tokens = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executableIndex = tokens.findIndex((token) => {
    const unquoted = token.replace(/^["']|["']$/g, "");
    return unquoted.split("/").pop() === executable;
  });
  return executableIndex < 0 ? null : tokens.slice(executableIndex + 1);
}

function piInvocationWords(command: string): string[] | null {
  for (const segment of splitShellCommandSegments(command)) {
    if (detectAgentCommand(segment) === "PI") return tokenizeShellWords(segment);
  }
  return null;
}

function piCommandArgs(command: string): string[] | null {
  const tokens = piInvocationWords(command);
  if (!tokens) return null;
  const packageIndex = tokens.findIndex((token) => PI_PACKAGE.test(token));
  if (packageIndex >= 0) return tokens.slice(packageIndex + 1);
  const directIndex = tokens.findIndex((token) => token.split("/").pop() === "pi");
  return directIndex < 0 ? null : tokens.slice(directIndex + 1);
}

function piLauncher(command: string): string[] | null {
  const tokens = piInvocationWords(command) ?? [];
  const packageToken = tokens.find((token) => PI_PACKAGE.test(token));
  if (packageToken) return PI_PINNED_PACKAGE.test(packageToken)
    ? ["npx", "-y", packageToken]
    : null;
  const direct = tokens.find((token) => token.split("/").pop() === "pi");
  if (direct) {
    const executable = direct;
    if (/^(?:[A-Za-z0-9._~+-]+\/)*pi$/.test(executable)) return [executable];
    return ["pi"];
  }
  return null;
}

/**
 * Whether a detected invocation represents an interactive session worth
 * showing as resumable. Version/help/auth/exec-style utility commands still
 * start the same binary, but manufacturing a resume card for them is wrong.
 */
export function isResumableAgentInvocation(agent: AgentCode, command: string): boolean {
  if (agent !== "CC" && agent !== "CX" && agent !== "PI") return false;
  const executable = agent === "CC" ? "claude" : agent === "CX" ? "codex" : "pi";
  const args = agent === "PI" ? piCommandArgs(command) : commandArgs(command, executable);
  if (!args) return true;
  if (args.some((token) => NON_INTERACTIVE_FLAGS[agent].has(unquoteToken(token).split("=")[0]))) return false;
  if (agent === "PI") return piLauncher(command) !== null && parseResumeId(command) !== null;

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

/** Parse only real Claude/Codex/Pi resume CLI positions, never prompt text. */
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
  if (agent === "PI") {
    const args = piCommandArgs(command) ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const token = unquoteToken(args[index]);
      if (token === "--") break;
      for (const name of ["--session-id", "--session"]) {
        if (token.startsWith(`${name}=`)) {
          return normalizeResumeId(token.slice(name.length + 1));
        }
        if (token === name) {
          return normalizeResumeId(unquoteToken(args[index + 1] ?? ""));
        }
      }
      if (token.startsWith("--") && token.includes("=")) continue;
      if (PI_FLAGS_WITH_VALUES.has(token)) {
        index += 1;
        continue;
      }
      if (!token.startsWith("-")) break;
    }
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
    provenance: session.remote
      ? {
          transport: "ssh",
          host: session.remote.host,
          port: session.remote.port,
          user: session.remote.user,
          ...(session.remote.identityFile?.trim()
            ? { identityFile: session.remote.identityFile.trim() }
            : {}),
        }
      : { transport: "local" },
    ...(resumeId ? { resumeId } : {}),
    lastSeenAt: now,
    confidence: resumeId ? "exact" : continueMatch ? "continue" : "unknown",
  };
  if (
    existing?.agent === next.agent
    && existing.command === next.command
    && existing.cwd === next.cwd
    && JSON.stringify(existing.provenance) === JSON.stringify(next.provenance)
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

function boundedOptionValue(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = unquoteToken(args[index]);
    const value = token === name
      ? unquoteToken(args[index + 1] ?? "")
      : token.startsWith(`${name}=`)
        ? unquoteToken(token.slice(name.length + 1))
        : "";
    if (value && !value.startsWith("-") && value.length <= 1024 && !/[\0\r\n]/.test(value)) return value;
  }
  return null;
}

function resumeSafetyFlags(intent: AgentResumeIntent): string[] {
  if (intent.agent === "PI") {
    const args = piCommandArgs(intent.command) ?? [];
    const flags = PI_TIGHTENING_FLAGS.filter((flag) =>
      args.some((token) => unquoteToken(token) === flag));
    const sessionDir = boundedOptionValue(args, "--session-dir");
    if (sessionDir) flags.push("--session-dir", sessionDir);
    return flags;
  }
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
  if (intent.agent === "PI") {
    if (!intent.resumeId || intent.confidence !== "exact") return null;
    const launcher = piLauncher(intent.command);
    if (!launcher) return null;
    return joinCommand([...launcher, ...resumeSafetyFlags(intent), "--session", intent.resumeId]);
  }
  return null;
}

function provenanceMatchesSession(
  intent: AgentResumeIntent,
  session: Pick<Session, "dir" | "remote" | "connection">,
): boolean {
  if (!intent.provenance) return false;
  if (intent.provenance.transport === "local") return !session.remote;
  return Boolean(
    session.remote
    && session.connection?.phase === "ready"
    && session.remote.host === intent.provenance.host
    && session.remote.port === intent.provenance.port
    && session.remote.user === intent.provenance.user
    && (session.remote.identityFile?.trim() ?? "") === (intent.provenance.identityFile ?? ""),
  );
}

export function agentResumePendingInput(command: string): Pick<Session, "pendingInput" | "pendingInputSubmit"> {
  return { pendingInput: command, pendingInputSubmit: true };
}

export function buildAgentResumeLaunchCommand(
  intent: AgentResumeIntent | undefined,
  session: Pick<Session, "dir" | "remote" | "connection">,
): string | null {
  if (intent && !provenanceMatchesSession(intent, session)) return null;
  const command = buildAgentResumeCommand(intent);
  if (!command || !intent) return command;
  const resumeCwd = intent.cwd.trim();
  if (!resumeCwd || resumeCwd === session.dir) return command;
  return `cd -- ${shellQuoteCwd(resumeCwd)} && ${command}`;
}
