import type { MenuEntry } from "../../../ui/ContextMenu";
import type { TerminalCommandBlock } from "./terminal-blocks";

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
    { id: "block:copy-command", label: "复制命令", icon: "copy", action: () => { handlers.onCopyCommand(block.id); } },
    { id: "block:copy-output", label: "复制输出", icon: "copy", disabled: !completed, action: () => { handlers.onCopyOutput(block.id); } },
    { id: "block:copy-both", label: "复制命令和输出", icon: "copy", disabled: !completed, action: () => { handlers.onCopyCommandAndOutput(block.id); } },
    { id: "block:filter-output", label: "筛选输出", icon: "search", disabled: !completed, action: () => { handlers.onFilterBlock(block); } },
    null,
    { id: "block:reveal", label: "滚动到命令", icon: "terminal", action: () => { handlers.onReveal(block.id); } },
    { id: "block:toggle", label: collapsed ? "展开输出" : "折叠输出", icon: "terminal", action: () => { handlers.onToggle(block.id); } },
  ];
}
