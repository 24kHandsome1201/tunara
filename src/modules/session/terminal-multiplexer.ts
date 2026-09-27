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

const ZELLIJ_SESSION_FLAGS = new Set(["-s", "--session"]);
const ZELLIJ_ATTACH = new Set(["attach", "a"]);

/**
 * Zellij session a tab is attached to: the name given on the command line
 * (`-s name`, `attach name`), else the one Zellij writes into the terminal
 * title (`name` or `name | pane title`).
 */
export function zellijSessionName(session: Pick<Session, "lastCommand" | "shellTitle">): string | null {
  const words = session.lastCommand?.trim().split(/\s+/) ?? [];
  for (let i = 0; i < words.length - 1; i += 1) {
    if (ZELLIJ_SESSION_FLAGS.has(words[i])) return words[i + 1];
    if (ZELLIJ_ATTACH.has(words[i])) {
      const name = words.slice(i + 1).find((word) => !word.startsWith("-"));
      if (name) return name;
    }
  }
  const title = session.shellTitle?.split(" | ")[0]?.trim();
  return title && !/\s/.test(title) ? title : null;
}

export function terminalMultiplexerLabel(multiplexer: TerminalMultiplexer): string {
  return MULTIPLEXER_LABELS[multiplexer];
}
