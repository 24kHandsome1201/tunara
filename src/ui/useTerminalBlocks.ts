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

function compactCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? singleLine.slice(0, 77) + "..." : singleLine;
}

function readBlockText(term: Terminal, block: TerminalCommandBlock): string {
  const buffer = term.buffer.active;
  const end = Math.min(block.endRow, buffer.baseY + buffer.length);
  const lines: string[] = [];
  for (let row = Math.max(0, block.startRow); row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").trimEnd();
}

export function useTerminalBlocks(termRef: RefObject<Terminal | null>) {
  const [blocks, setBlocks] = useState<TerminalCommandBlock[]>([]);
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Record<string, true>>({});
  const activeBlockRef = useRef<TerminalCommandBlock | null>(null);
  const blocksRef = useRef<TerminalCommandBlock[]>([]);

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
    updateBlocks((items) => items.map((item) => item.id === active.id ? completed : item));
  }, [updateBlocks]);

  const copyBlock = useCallback((id: string) => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block) return;
    navigator.clipboard.writeText(readBlockText(term, block)).catch(() => {});
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

  return { blocks, collapsedBlockIds, beginBlock, finishBlock, copyBlock, toggleBlock };
}
