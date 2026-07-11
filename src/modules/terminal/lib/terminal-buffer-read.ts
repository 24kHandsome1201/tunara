import type { Terminal } from "@xterm/xterm";
import { cleanTerminalLines, cleanTerminalText } from "./terminal-utils.ts";

export interface TerminalBufferPosition {
  row: number;
  column: number;
}

export function extractCommandFromBuffer(term: Terminal, promptEnd: TerminalBufferPosition): string {
  const cursorY = term.buffer.active.cursorY + term.buffer.active.baseY;
  let command = "";
  for (let row = promptEnd.row; row <= cursorY; row += 1) {
    const line = term.buffer.active.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true, row === promptEnd.row ? promptEnd.column : 0);
    // A terminal soft-wrap is presentation only and must not manufacture a
    // space inside flags, paths, environment names, or session IDs. Real
    // multi-line shell input still receives a separator so adjacent commands
    // cannot collapse into one token.
    if (command && !line.isWrapped) command += " ";
    command += text;
  }
  return cleanTerminalText(command).trim();
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
