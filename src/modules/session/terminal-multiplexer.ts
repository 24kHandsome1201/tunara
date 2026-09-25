import type { Session } from "@/ui/types";

export type TerminalMultiplexer = "herdr" | "tmux" | "zellij" | "screen";

const MULTIPLEXER_LABELS: Record<TerminalMultiplexer, string> = {
  herdr: "HerdR",
  tmux: "tmux",
  zellij: "Zellij",
  screen: "screen",
};

/** First program in a command line, skipping `VAR=value` prefixes, `env`, `exec` and `command`. */
export function detectTerminalMultiplexer(command: string | undefined): TerminalMultiplexer | null {
  if (!command) return null;
  const words = command.trim().split(/\s+/);
  let index = 0;
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]) || ["env", "exec", "command"].includes(words[index]))) {
    index += 1;
  }
  const program = words[index]?.split("/").pop();
  return program === "herdr" || program === "tmux" || program === "zellij" || program === "screen" ? program : null;
}

/** The multiplexer currently running in the foreground of a non-Agent session, if any. */
export function sessionTerminalMultiplexer(session: Pick<Session, "agent" | "runState" | "lastCommand">): TerminalMultiplexer | null {
  if (session.agent || session.runState !== "running") return null;
  return detectTerminalMultiplexer(session.lastCommand);
}

export function terminalMultiplexerLabel(multiplexer: TerminalMultiplexer): string {
  return MULTIPLEXER_LABELS[multiplexer];
}
