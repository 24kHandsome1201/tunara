import { useCallback, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { hasPlatformModKey } from "../modules/config/keybindings.ts";

import {
  findNavigableCommandBlock,
  findStickyCommandBlock,
  formatTerminalBlockCommandAndOutput,
  normalizeBlockCommand,
  type TerminalCommandBlock,
} from "@/modules/terminal/lib/terminal-blocks";

function detectMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

const isMac = detectMacPlatform();

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

function hasBlockNavigationModifier(e: KeyboardEvent): boolean {
  return hasPlatformModKey(e, isMac) && (isMac ? !e.ctrlKey : !e.metaKey);
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
      command: normalizeBlockCommand(command),
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

  const readBlockOutput = useCallback((id: string): string | null => {
    const term = termRef.current;
    const block = blocksRef.current.find((item) => item.id === id);
    if (!term || !block) return null;
    return readBlockOutputText(term, block);
  }, [termRef]);

  const copyBlockOutput = useCallback(async (id: string): Promise<boolean> => {
    const output = readBlockOutput(id);
    if (output === null) return false;
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
    if (e.type !== "keydown" || !hasBlockNavigationModifier(e) || !e.shiftKey || e.altKey) return true;
    if (e.key === "ArrowUp") {
      navigateBlock("previous");
      return false;
    }
    if (e.key === "ArrowDown") {
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
