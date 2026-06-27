export interface TerminalBlockMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface TerminalCommandBlock {
  id: string;
  command: string;
  startRow: number;
  endRow: number;
  startMarker?: TerminalBlockMarker;
  endMarker?: TerminalBlockMarker;
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
}

export function resolveTerminalBlockRows(
  block: Pick<TerminalCommandBlock, "startRow" | "endRow" | "startMarker" | "endMarker">,
): { startRow: number; endRow: number } | null {
  const startRow = block.startMarker
    ? (!block.startMarker.isDisposed && block.startMarker.line >= 0 ? block.startMarker.line : null)
    : block.startRow;
  const endRow = block.endMarker
    ? (!block.endMarker.isDisposed && block.endMarker.line >= 0 ? block.endMarker.line : null)
    : block.endRow;
  if (startRow === null || endRow === null || endRow < startRow) return null;
  return { startRow, endRow };
}

export function findStickyCommandBlock(
  blocks: TerminalCommandBlock[],
  viewportY: number,
  _viewportRows: number,
  bottomViewportY = Number.POSITIVE_INFINITY,
): TerminalCommandBlock | null {
  if (viewportY >= bottomViewportY) return null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    const rows = resolveTerminalBlockRows(block);
    if (!rows) continue;
    if (viewportY > rows.startRow && viewportY <= Math.max(rows.startRow, rows.endRow)) {
      return block;
    }
  }
  return null;
}

export function normalizeBlockCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

export function collectTerminalBlockOutputText(
  lines: readonly string[],
  block: Pick<TerminalCommandBlock, "startRow" | "endRow" | "startMarker" | "endMarker">,
): string {
  const rows = resolveTerminalBlockRows(block);
  if (!rows) return "";
  const start = Math.max(0, rows.startRow + 1);
  const end = Math.min(rows.endRow, lines.length - 1);
  if (end < start) return "";
  return lines.slice(start, end + 1).join("\n").trimEnd();
}

export function formatTerminalBlockCommandAndOutput(command: string, output: string): string {
  return output ? `${command}\n${output}` : command;
}

export function findNavigableCommandBlock(
  blocks: readonly TerminalCommandBlock[],
  viewportY: number,
  direction: "previous" | "next",
): TerminalCommandBlock | null {
  if (direction === "previous") {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const rows = resolveTerminalBlockRows(blocks[i]);
      if (rows && rows.startRow < viewportY) return blocks[i];
    }
    return null;
  }
  return blocks.find((block) => {
    const rows = resolveTerminalBlockRows(block);
    return !!rows && rows.startRow > viewportY;
  }) ?? null;
}
