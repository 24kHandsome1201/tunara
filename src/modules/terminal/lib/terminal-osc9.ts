import type { Terminal } from "@xterm/xterm";
import type { TerminalProgress } from "../../../ui/types.ts";
import { parseOsc7 } from "./osc-handlers.ts";
import { parseTerminalNotificationOsc9, type TerminalNotification } from "./terminal-notification.ts";
import { parseTerminalProgressOsc } from "./terminal-progress.ts";

export interface TerminalOsc9Handlers {
  onProgress: (progress: TerminalProgress | undefined) => void;
  onNotification?: (notification: TerminalNotification) => void;
  onCwd?: (cwd: string) => void;
}

export function registerTerminalOsc9Handler(
  term: Terminal,
  handlers: TerminalOsc9Handlers,
): () => void {
  const disposable = term.parser.registerOscHandler(9, (data) => {
    const signal = parseTerminalProgressOsc(data);
    if (signal) {
      handlers.onProgress(signal.progress ?? undefined);
      return true;
    }

    const cwd = parseConEmuCwdOsc9(data);
    if (cwd) {
      handlers.onCwd?.(cwd);
      return true;
    }

    const notification = parseTerminalNotificationOsc9(data);
    if (!notification) return false;
    handlers.onNotification?.(notification);
    return true;
  });
  return () => disposable.dispose();
}

export function parseConEmuCwdOsc9(data: string): string | null {
  const match = data.match(/^9;(.*)$/);
  if (!match) return null;
  return normalizeCwdPayload(match[1]);
}

function normalizeCwdPayload(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (isQuoted(value)) value = value.slice(1, -1).trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("file://")) return parseOsc7(value);
  if (value.startsWith("/") || value.startsWith("~")) return value;
  return null;
}

function isQuoted(value: string): boolean {
  return (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  );
}
