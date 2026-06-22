import { useCallback, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";

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

function compactCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? singleLine.slice(0, 77) + "..." : singleLine;
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

function readBlockOutputText(term: Terminal, block: TerminalCommandBlock): string {
  const buffer = term.buffer.active;
  const end = Math.min(block.endRow, buffer.baseY + buffer.length);
  const lines: string[] = [];
  for (let row = Math.max(0, block.startRow + 1); row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").trimEnd();
}

export function useTerminalBlocks(termRef: RefObject<Terminal | null>) {
  const [blocks, setBlocks] = useState<TerminalCommandBlock[]>([]);
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Record<string, true>>({});
  const [stickyBlock, setStickyBlock] = useState<TerminalCommandBlock | null>(null);
  const activeBlockRef = useRef<TerminalCommandBlock | null>(null);
  const blocksRef = useRef<TerminalCommandBlock[]>([]);

  const refreshStickyBlock = useCallback((term: Terminal) => {
    const buffer = term.buffer.active;
    const next = findStickyCommandBlock(blocksRef.current, buffer.viewportY, term.rows, buffer.baseY);
    setStickyBlock((current) => {
      if (current?.id === next?.id && current?.endRow === next?.endRow && current?.exitCode === next?.exitCode) return current;
      return next;
    });
  }, []);

  const updateBlocks = useCallback((updater: (blocks: TerminalCommandBlock[]) => TerminalCommandBlock[]) => {
    setBlocks((current) => {
      const next = updater(current).slice(-24);
      blocksRef.current = next;
      return next;
    });
  }, []);

  const beginBlock = useCallback((command: string, startRow: number) => {
    const now = Date.now();
    const block: TerminalCommandBlock = {
      id: `block-${now}-${Math.max(0, startRow)}`,
      command: compactCommand(command),
      startRow: Math.max(0, startRow),
      endRow: Math.max(0, startRow),
      startedAt: now,
    };
    activeBlockRef.current = block;
    updateBlocks((items) => [...items, block]);
  }, [updateBlocks]);

  const finishBlock = useCallback((exitCode: number, endRow: number) => {
    const active = activeBlockRef.current;
    if (!active) return;
    const completed = {
      ...active,
      endRow: Math.max(active.startRow, endRow),
      exitCode,
      completedAt: Date.now(),
    };
    activeBlockRef.current = null;
    setStickyBlock((current) => current?.id === active.id ? completed : current);
    updateBlocks((items) => items.map((item) => item.id === active.id ? completed : item));
  }, [updateBlocks]);

  const updateActiveBlockEnd = useCallback((endRow: number) => {
    const active = activeBlockRef.current;
    if (!active) return;
    const nextEnd = Math.max(active.endRow, endRow);
    if (nextEnd === active.endRow) return;
    const next = { ...active, endRow: nextEnd };
    activeBlockRef.current = next;
    blocksRef.current = blocksRef.current.map((item) => item.id === active.id ? next : item);
    setStickyBlock((current) => current?.id === active.id ? next : current);
  }, []);

  const copyBlock = useCallback(async (id: string): Promise<boolean> => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block) return false;
    try {
      await navigator.clipboard.writeText(readBlockOutputText(term, block));
      return true;
    } catch {
      return false;
    }
  }, [termRef]);

  const toggleBlock = useCallback((id: string) => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block) return;
    setCollapsedBlockIds((current) => {
      if (current[id]) {
        const { [id]: _, ...rest } = current;
        term.scrollToLine(block.startRow);
        return rest;
      }
      term.scrollToLine(block.endRow);
      return { ...current, [id]: true };
    });
  }, [termRef]);

  const revealBlock = useCallback((id: string) => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block) return;
    term.scrollToLine(block.startRow);
  }, [termRef]);

  const registerScrollTracking = useCallback((term: Terminal) => {
    const scrollDisposable = term.onScroll(() => refreshStickyBlock(term));
    refreshStickyBlock(term);
    return () => scrollDisposable.dispose();
  }, [refreshStickyBlock]);

  return {
    blocks,
    collapsedBlockIds,
    stickyBlock,
    beginBlock,
    finishBlock,
    updateActiveBlockEnd,
    copyBlock,
    toggleBlock,
    revealBlock,
    registerScrollTracking,
  };
}
