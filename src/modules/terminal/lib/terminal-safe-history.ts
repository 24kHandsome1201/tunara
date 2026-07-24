import type { Terminal } from "@xterm/xterm";

export const MAX_SAFE_TERMINAL_HISTORY_BYTES = 256 * 1024;

const UNSAFE_VISIBLE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeTerminalHistoryText(text: string): string {
  return text
    .normalize("NFC")
    .replace(UNSAFE_VISIBLE_CONTROLS, "")
    .replace(/\r\n?/g, "\n");
}

export function tailTerminalHistoryWithinUtf8Limit(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) return text;

  const codePoints = Array.from(text);
  let bytes = 0;
  let start = codePoints.length;
  while (start > 0) {
    const next = encoder.encode(codePoints[start - 1]).byteLength;
    if (bytes + next > limit) break;
    bytes += next;
    start -= 1;
  }
  return codePoints.slice(start).join("");
}

/**
 * Project rendered cells into inert text. This deliberately ignores cursor
 * state, alternate buffers, OSC/CSI, mouse modes and renderer state: reconnect
 * history is display context, never a terminal protocol replay.
 */
export function captureSafeTerminalHistory(
  terminal: Pick<Terminal, "buffer">,
  maxBytes = MAX_SAFE_TERMINAL_HISTORY_BYTES,
): string {
  const normal = terminal.buffer.normal;
  if (!normal) return "";
  const lines: string[] = [];
  for (let index = 0; index < normal.length; index += 1) {
    const line = normal.getLine(index);
    if (!line) continue;
    const text = sanitizeTerminalHistoryText(line.translateToString(true));
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return tailTerminalHistoryWithinUtf8Limit(lines.join("\n"), Math.max(0, maxBytes));
}

/** Convert inert history into trusted xterm input without reintroducing data controls. */
export function safeHistoryForTerminal(history: string, restoredLabel: string): string {
  const safe = sanitizeTerminalHistoryText(history).replace(/\n/g, "\r\n");
  const prefix = safe ? `${safe}\r\n` : "";
  return `${prefix}\x1b[2m[${sanitizeTerminalHistoryText(restoredLabel)}]\x1b[0m\r\n`;
}
