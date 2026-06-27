import { useCallback, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { matchesKeybinding } from "../modules/config/keybindings.ts";
import { useUIStore } from "@/state/ui";

import {
  findNavigableCommandBlock,
  findStickyCommandBlock,
  formatTerminalBlockCommandAndOutput,
  normalizeBlockCommand,
  resolveTerminalBlockRows,
  type TerminalBlockMarker,
  type TerminalCommandBlock,
} from "@/modules/terminal/lib/terminal-blocks";

function detectMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

const isMac = detectMacPlatform();

function currentBufferRow(term: Terminal): number {
  const buffer = term.buffer.active;
  return buffer.cursorY + buffer.baseY;
}

function createBlockMarker(term: Terminal, row: number): TerminalBlockMarker | undefined {
  const buffer = term.buffer.active;
  if (buffer.length <= 0) return undefined;
  const boundedRow = Math.max(0, Math.min(Math.floor(row), buffer.length - 1));
  return term.registerMarker(boundedRow - currentBufferRow(term));
}

function disposeBlockMarker(marker?: TerminalBlockMarker) {
  if (marker && !marker.isDisposed) marker.dispose();
}

function disposeBlockMarkers(block: TerminalCommandBlock) {
  disposeBlockMarker(block.startMarker);
  if (block.endMarker !== block.startMarker) disposeBlockMarker(block.endMarker);
}

function withEndMarker(term: Terminal, block: TerminalCommandBlock, endRow: number): TerminalCommandBlock {
  const rows = resolveTerminalBlockRows(block);
  const startRow = rows?.startRow ?? block.startRow;
  const nextEndRow = Math.max(startRow, Math.floor(endRow));
  const nextMarker = createBlockMarker(term, nextEndRow);
  if (block.endMarker && block.endMarker !== block.startMarker && block.endMarker !== nextMarker) {
    disposeBlockMarker(block.endMarker);
  }
  return { ...block, endRow: nextEndRow, endMarker: nextMarker };
}

function readBlockOutputText(term: Terminal, block: TerminalCommandBlock): string | null {
  const rows = resolveTerminalBlockRows(block);
  if (!rows) return null;
  const buffer = term.buffer.active;
  const end = Math.min(rows.endRow, buffer.length - 1);
  const start = Math.max(0, rows.startRow + 1);
  if (end < start) return "";
  const lines: string[] = [];
  for (let row = start; row <= end; row += 1) {
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
      const retained = new Set(next.map((item) => item.id));
      for (const item of current) {
        if (!retained.has(item.id)) disposeBlockMarkers(item);
      }
      blocksRef.current = next;
      return next;
    });
  }, []);

  const beginBlock = useCallback((command: string, startRow: number) => {
    const now = Date.now();
    const term = termRef.current;
    const normalizedStartRow = Math.max(0, Math.floor(startRow));
    const startMarker = term ? createBlockMarker(term, normalizedStartRow) : undefined;
    const block: TerminalCommandBlock = {
      id: `block-${now}-${normalizedStartRow}`,
      command: normalizeBlockCommand(command),
      startRow: normalizedStartRow,
      endRow: normalizedStartRow,
      startMarker,
      endMarker: startMarker,
      startedAt: now,
    };
    activeBlockRef.current = block;
    updateBlocks((items) => [...items, block]);
  }, [termRef, updateBlocks]);

  const finishBlock = useCallback((exitCode: number, endRow: number) => {
    const active = activeBlockRef.current;
    if (!active) return;
    const term = termRef.current;
    const rows = resolveTerminalBlockRows(active);
    const startRow = rows?.startRow ?? active.startRow;
    const completedBase = {
      ...active,
      endRow: Math.max(startRow, endRow),
      exitCode,
      completedAt: Date.now(),
    };
    const completed = term ? withEndMarker(term, completedBase, endRow) : completedBase;
    activeBlockRef.current = null;
    setStickyBlock((current) => current?.id === active.id ? completed : current);
    updateBlocks((items) => items.map((item) => item.id === active.id ? completed : item));
  }, [termRef, updateBlocks]);

  const updateActiveBlockEnd = useCallback((endRow: number) => {
    const active = activeBlockRef.current;
    if (!active) return;
    const rows = resolveTerminalBlockRows(active);
    const currentEnd = rows?.endRow ?? active.endRow;
    const nextEnd = Math.max(currentEnd, Math.floor(endRow));
    if (nextEnd === currentEnd && nextEnd === active.endRow) return;
    const term = termRef.current;
    const nextBase = { ...active, endRow: nextEnd };
    const next = term ? withEndMarker(term, nextBase, nextEnd) : nextBase;
    activeBlockRef.current = next;
    blocksRef.current = blocksRef.current.map((item) => item.id === active.id ? next : item);
    setStickyBlock((current) => current?.id === active.id ? next : current);
  }, [termRef]);

  const readBlockOutput = useCallback((id: string): string | null => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block) return null;
    return readBlockOutputText(term, block);
  }, [termRef]);

  const copyBlockOutput = useCallback(async (id: string): Promise<boolean> => {
    const output = readBlockOutput(id);
    if (output === null || output.length === 0) return false;
    try {
      await navigator.clipboard.writeText(output);
      return true;
    } catch {
      return false;
    }
  }, [readBlockOutput]);

  const copyBlockCommand = useCallback(async (id: string): Promise<boolean> => {
    const block = blocksRef.current.find((item) => item.id === id);
    if (!block?.command) return false;
    try {
      await navigator.clipboard.writeText(block.command);
      return true;
    } catch {
      return false;
    }
  }, []);

  const copyBlockCommandAndOutput = useCallback(async (id: string): Promise<boolean> => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block?.command) return false;
    const output = readBlockOutputText(term, block);
    if (output === null) return false;
    const text = formatTerminalBlockCommandAndOutput(block.command, output);
    try {
      await navigator.clipboard.writeText(text);
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

  const navigateBlock = useCallback((direction: "previous" | "next") => {
    const term = termRef.current;
    if (!term) return false;
    const block = findNavigableCommandBlock(blocksRef.current, term.buffer.active.viewportY, direction);
    if (!block) return false;
    term.scrollToLine(block.startRow);
    return true;
  }, [termRef]);

  const handleCustomKeyEvent = useCallback((e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    const bindings = useUIStore.getState().keybindings;
    if (matchesKeybinding(e, bindings.navigatePrevBlock, isMac)) {
      navigateBlock("previous");
      return false;
    }
    if (matchesKeybinding(e, bindings.navigateNextBlock, isMac)) {
      navigateBlock("next");
      return false;
    }
    return true;
  }, [navigateBlock]);

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
    copyBlockCommand,
    copyBlockCommandAndOutput,
    copyBlockOutput,
    readBlockOutput,
    toggleBlock,
    revealBlock,
    handleCustomKeyEvent,
    registerScrollTracking,
  };
}
