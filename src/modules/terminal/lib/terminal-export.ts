export const MAX_TERMINAL_EXPORT_LINES = 2000;
export const MAX_TERMINAL_EXPORT_BYTES = 256 * 1024;

export interface TerminalExportText {
  text: string;
  truncated: boolean;
  lineCount: number;
}

export interface TerminalExportBuffer {
  length: number;
  getLine(row: number): { translateToString(trimRight: boolean): string } | undefined;
}

/**
 * Keep the most recent lines/bytes of a terminal dump. Matches the large-file
 * viewer ceilings so an export cannot dump an unbounded scrollback.
 */
export function clipTerminalExportText(
  text: string,
  maxLines = MAX_TERMINAL_EXPORT_LINES,
  maxBytes = MAX_TERMINAL_EXPORT_BYTES,
): TerminalExportText {
  const normalized = text.replace(/\u0000/g, "");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  let truncated = false;
  let kept = lines;
  if (kept.length > maxLines) {
    kept = kept.slice(kept.length - maxLines);
    truncated = true;
  }
  let joined = kept.join("\n");
  if (joined.length > maxBytes) {
    joined = joined.slice(joined.length - maxBytes);
    const firstNewline = joined.indexOf("\n");
    if (firstNewline !== -1) joined = joined.slice(firstNewline + 1);
    truncated = true;
  }
  const lineCount = joined.length === 0 ? 0 : joined.split("\n").length;
  return { text: joined, truncated, lineCount };
}

export function collectTerminalBufferText(
  buffer: TerminalExportBuffer,
  maxLines = MAX_TERMINAL_EXPORT_LINES,
  maxBytes = MAX_TERMINAL_EXPORT_BYTES,
): TerminalExportText {
  const end = Math.max(0, buffer.length);
  const start = Math.max(0, end - maxLines);
  const lines: string[] = [];
  for (let row = start; row < end; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return clipTerminalExportText(lines.join("\n"), maxLines, maxBytes);
}
