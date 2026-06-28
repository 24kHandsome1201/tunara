import type { MenuEntry } from "../../../ui/ContextMenu";
import type { TerminalCommandBlock } from "./terminal-blocks";
import { t } from "../../i18n/core.ts";

export interface BlockContextMenuHandlers {
  onCopyCommand: (id: string) => unknown;
  onCopyOutput: (id: string) => unknown;
  onCopyCommandAndOutput: (id: string) => unknown;
  onFilterBlock: (block: TerminalCommandBlock) => unknown;
  onReveal: (id: string) => unknown;
  onToggle: (id: string) => unknown;
}

export function buildBlockContextMenuItems(
  block: TerminalCommandBlock,
  completed: boolean,
  collapsed: boolean,
  handlers: BlockContextMenuHandlers,
): MenuEntry[] {
  return [
    { id: "block:copy-command", label: t("block.menu.copy_command"), icon: "copy", action: () => { handlers.onCopyCommand(block.id); } },
    { id: "block:copy-output", label: t("block.menu.copy_output"), icon: "copy", disabled: !completed, action: () => { handlers.onCopyOutput(block.id); } },
    { id: "block:copy-both", label: t("block.menu.copy_both"), icon: "copy", disabled: !completed, action: () => { handlers.onCopyCommandAndOutput(block.id); } },
    { id: "block:filter-output", label: t("block.menu.filter_output"), icon: "search", disabled: !completed, action: () => { handlers.onFilterBlock(block); } },
    null,
    { id: "block:reveal", label: t("block.menu.reveal"), icon: "terminal", action: () => { handlers.onReveal(block.id); } },
    { id: "block:toggle", label: collapsed ? t("block.menu.expand") : t("block.menu.collapse"), icon: "terminal", action: () => { handlers.onToggle(block.id); } },
  ];
}
