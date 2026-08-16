import { useCallback, type RefObject } from "react";
import { buildBlockContextMenuItems } from "@/modules/terminal/lib/terminal-blocks-menu";
import { exportTerminalTextToFile } from "@/modules/terminal/lib/terminal-export-file";
import { useSessionsStore } from "@/state/sessions";
import type { MenuEntry } from "./ContextMenu";
import type { useTerminalBlocks } from "./useTerminalBlocks";

/**
 * Context-menu entries for the command block under a viewport pixel, resolved
 * at menu-open time. Rerun only prefills the session's input line
 * (pendingInputSubmit: false) — Tunara never submits commands on the user's
 * behalf.
 */
export function useTerminalBlockMenu(
  blocks: ReturnType<typeof useTerminalBlocks>,
  sessionIdRef: RefObject<string>,
): (clientX: number, clientY: number) => MenuEntry[] {
  const { blockAtPixel, copyBlockCommand, copyBlockOutput, copyBlockCommandAndOutput, readBlockOutput, revealBlock } = blocks;
  return useCallback((clientX: number, clientY: number): MenuEntry[] => {
    const block = blockAtPixel(clientX, clientY);
    if (!block) return [];
    return buildBlockContextMenuItems(block, {
      onRerun: (command) => useSessionsStore.getState().updateSession(sessionIdRef.current, { pendingInput: command, pendingInputSubmit: false }),
      onCopyCommand: (id) => { void copyBlockCommand(id); },
      onCopyOutput: (id) => { void copyBlockOutput(id); },
      onCopyCommandAndOutput: (id) => { void copyBlockCommandAndOutput(id); },
      onExportOutput: (id) => {
        const output = readBlockOutput(id);
        if (output == null) return;
        void exportTerminalTextToFile(output, "tunara-command.txt", sessionIdRef.current);
      },
      onReveal: revealBlock,
    });
  }, [blockAtPixel, copyBlockCommand, copyBlockOutput, copyBlockCommandAndOutput, readBlockOutput, revealBlock, sessionIdRef]);
}
