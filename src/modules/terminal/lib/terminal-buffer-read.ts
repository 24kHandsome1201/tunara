import type { Terminal } from "@xterm/xterm";
import { cleanTerminalLines, cleanTerminalText } from "./terminal-utils.ts";

export function extractCommandFromBuffer(term: Terminal, promptEndRow: number): string {
  const cursorY = term.buffer.active.cursorY + term.buffer.active.baseY;
  const parts: string[] = [];
  for (let row = promptEndRow; row <= cursorY; row += 1) {
    const line = term.buffer.active.getLine(row);
    if (line) parts.push(line.translateToString(true));
  }
  return cleanTerminalText(parts.join(" ")).trim();
}

export function extractCommandFromOsc(data: string): string {
  if (!data.startsWith("C;")) return "";
  try {
    return decodeURIComponent(data.slice(2)).trim();
  } catch {
    return "";
  }
}

export function resolveTerminalCommandText(
  oscData: string,
  submittedCommand: string | null,
  bufferCommand: string,
): string {
  const oscCommand = extractCommandFromOsc(oscData);
  if (oscCommand) return oscCommand;
  const submitted = cleanTerminalText(submittedCommand ?? "").trim();
  return submitted || bufferCommand;
}

export function getTerminalTailText(term: Terminal, rowCount = 12): string {
  const buffer = term.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  const start = Math.max(0, cursorRow - rowCount);
  // Full-screen TUIs can paint status rows below the input cursor. Read a
  // bounded window on both sides of the cursor; trailing blank terminal rows
  // are removed by cleanTerminalLines, so ordinary shell/Codex prompts retain
  // the same effective tail while Pi's lower status bar becomes observable.
  const end = Math.min(buffer.length - 1, cursorRow + rowCount);
  const parts: string[] = [];
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (line) parts.push(line.translateToString(true));
  }
  return cleanTerminalLines(parts.join("\n"));
}
