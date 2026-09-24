export function normalizedScrollPosition(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const range = Math.max(scrollHeight - clientHeight, 0);
  if (range === 0 || !Number.isFinite(scrollTop)) return 0;
  return Math.min(Math.max(scrollTop / range, 0), 1);
}

export function scrollTopForPosition(
  ratio: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const range = Math.max(scrollHeight - clientHeight, 0);
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(Math.max(ratio, 0), 1) * range;
}

/** Offset of a 1-based line/column inside `content`, clamped to the text. */
export function offsetForLineColumn(content: string, line: number, column = 1): number {
  if (!Number.isFinite(line) || line <= 1) {
    const lineEnd = content.indexOf("\n");
    return clampColumn(0, lineEnd < 0 ? content.length : lineEnd, column);
  }
  let start = 0;
  for (let current = 1; current < Math.floor(line); current += 1) {
    const next = content.indexOf("\n", start);
    if (next < 0) break;
    start = next + 1;
  }
  const lineEnd = content.indexOf("\n", start);
  return clampColumn(start, lineEnd < 0 ? content.length : lineEnd, column);
}

function clampColumn(lineStart: number, lineEnd: number, column: number): number {
  const offset = Number.isFinite(column) ? Math.floor(column) - 1 : 0;
  return lineStart + Math.min(Math.max(offset, 0), lineEnd - lineStart);
}
