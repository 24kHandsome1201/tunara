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
  if (text.length * 3 <= limit) return text;

  let bytes = 0;
  let start = text.length;
  while (start > 0) {
    const last = text.charCodeAt(start - 1);
    let units = 1;
    let size = last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
    if (last >= 0xdc00 && last <= 0xdfff) {
      const first = text.charCodeAt(start - 2);
      if (first >= 0xd800 && first <= 0xdbff) {
        units = 2;
        size = 4;
      }
    }
    bytes += size;
    if (bytes > limit) break;
    start -= units;
  }
  return text.slice(start);
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
  if (!normal || maxBytes < 1) return "";
  const chunks: string[] = [];
  let codeUnits = 0;
  let nextRowWrapped = true;
  for (let index = normal.length - 1; index >= 0; index -= 1) {
    const line = normal.getLine(index);
    if (!line) continue;
    const text = sanitizeTerminalHistoryText(line.translateToString(true));
    if (!text && chunks.length === 0) continue;
    // The newer row decides whether this boundary is a newline.
    if (!nextRowWrapped) {
      chunks.push("\n");
      codeUnits += 1;
    }
    if (text) chunks.push(text);
    codeUnits += text.length;
    // UTF-8 needs at least one byte per UTF-16 unit. The extra unit
    // keeps the cutoff safe even if a surrogate pair spans wrapped rows.
    if (codeUnits > maxBytes) break;
    nextRowWrapped = line.isWrapped;
  }
  return tailTerminalHistoryWithinUtf8Limit(chunks.reverse().join(""), maxBytes);
}

/** Convert inert history into trusted xterm input without reintroducing data controls. */
export function safeHistoryForTerminal(history: string, restoredLabel = ""): string {
  const safe = sanitizeTerminalHistoryText(history).replace(/\n/g, "\r\n");
  const prefix = safe ? `${safe}\r\n` : "";
  if (!restoredLabel) return prefix;
  return `${prefix}\x1b[2m[${sanitizeTerminalHistoryText(restoredLabel)}]\x1b[0m\r\n`;
}
