import type { MenuEntry } from "../../../ui/ContextMenu";
import type { TerminalCommandBlock } from "./terminal-blocks";
import { t } from "../../i18n/core.ts";
import { formatElapsed } from "../../../ui/lib/elapsed.ts";

export interface BlockContextMenuHandlers {
  /** Prefill the command into the terminal input line without executing it. */
  onRerun: (command: string) => unknown;
  onCopyCommand: (id: string) => unknown;
  onCopyOutput: (id: string) => unknown;
  onCopyCommandAndOutput: (id: string) => unknown;
  onExportOutput: (id: string) => unknown;
  onReveal: (id: string) => unknown;
}

function blockDurationLabel(block: TerminalCommandBlock, now: number): string {
  const ms = Math.max(0, (block.completedAt ?? now) - block.startedAt);
  return ms < 1000 ? "<1s" : formatElapsed(ms);
}

/** Non-interactive heading summarizing the block: state, exit code, duration. */
export function blockStatusLabel(block: TerminalCommandBlock, now = Date.now()): string {
  const duration = blockDurationLabel(block, now);
  if (block.completedAt === undefined) return t("block.menu.status.running", { duration });
  if (block.exitCode !== undefined && block.exitCode !== 0) {
    return t("block.menu.status.failed", { code: block.exitCode, duration });
  }
  return t("block.menu.status.done", { duration });
}

export function buildBlockContextMenuItems(
  block: TerminalCommandBlock,
  handlers: BlockContextMenuHandlers,
  now = Date.now(),
): MenuEntry[] {
  const completed = block.completedAt !== undefined;
  return [
    { type: "heading", label: blockStatusLabel(block, now) },
    { id: "block:rerun", label: t("block.menu.rerun"), icon: "terminal", disabled: !block.command, action: () => { handlers.onRerun(block.command); } },
    null,
    { id: "block:copy-command", label: t("block.menu.copy_command"), icon: "copy", action: () => { handlers.onCopyCommand(block.id); } },
    { id: "block:copy-output", label: t("block.menu.copy_output"), icon: "copy", disabled: !completed, action: () => { handlers.onCopyOutput(block.id); } },
    { id: "block:copy-both", label: t("block.menu.copy_both"), icon: "copy", disabled: !completed, action: () => { handlers.onCopyCommandAndOutput(block.id); } },
    { id: "block:export-output", label: t("block.menu.export_output"), icon: "download", disabled: !completed, action: () => { handlers.onExportOutput(block.id); } },
    null,
    { id: "block:reveal", label: t("block.menu.reveal"), icon: "terminal", action: () => { handlers.onReveal(block.id); } },
  ];
}
