export const TERMINAL_QUICK_SELECT_SCOPE_LINES = 1000;

export interface TerminalQuickSelectRange {
  start: number;
  end: number;
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function terminalQuickSelectRange(
  bufferLength: number,
  viewportY: number,
  rows: number,
  scopeLines = TERMINAL_QUICK_SELECT_SCOPE_LINES,
): TerminalQuickSelectRange {
  const length = nonNegativeInt(bufferLength);
  if (length === 0) return { start: 0, end: -1 };

  const bufferEnd = length - 1;
  const viewportStart = Math.min(nonNegativeInt(viewportY), bufferEnd);
  const visibleRows = Math.max(1, nonNegativeInt(rows));
  const visibleEnd = Math.min(bufferEnd, viewportStart + visibleRows - 1);
  const scope = nonNegativeInt(scopeLines);

  return {
    start: Math.max(0, viewportStart - scope),
    end: Math.min(bufferEnd, visibleEnd + scope),
  };
}
