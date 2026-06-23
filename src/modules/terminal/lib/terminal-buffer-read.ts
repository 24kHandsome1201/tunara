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

export function getTerminalTailText(term: Terminal, rowCount = 12): string {
  const buffer = term.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  const start = Math.max(0, cursorRow - rowCount);
  const parts: string[] = [];
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (line) parts.push(line.translateToString(true));
  }
  return cleanTerminalLines(parts.join("\n"));
}
