export interface TerminalCommandBlock {
  id: string;
  command: string;
  startRow: number;
  endRow: number;
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
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
    if (viewportY > block.startRow && viewportY <= Math.max(block.startRow, block.endRow)) {
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
  block: Pick<TerminalCommandBlock, "startRow" | "endRow">,
): string {
  const start = Math.max(0, block.startRow + 1);
  const end = Math.min(block.endRow, lines.length - 1);
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
      if (blocks[i].startRow < viewportY) return blocks[i];
    }
    return null;
  }
  return blocks.find((block) => block.startRow > viewportY) ?? null;
}
