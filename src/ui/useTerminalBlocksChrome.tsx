import { useState, type ReactNode } from "react";
import type { Session } from "./types";
import type { useTerminalBlocks } from "./useTerminalBlocks";
import { AgentStatusBar } from "./AgentStatusBar";
import { TerminalBlocksBar } from "./TerminalBlocksBar";
import { TerminalBlockFilterPanel } from "./TerminalBlockFilterPanel";

interface UseTerminalBlocksChromeOptions {
  session: Session | undefined;
  blocks: ReturnType<typeof useTerminalBlocks>;
  /** 搜索栏打开时，过滤浮层下移让位（两者同开不互挡）。 */
  searchOpen: boolean;
}

interface TerminalBlocksChrome {
  /** 流内顶条：agent 状态条 + 命令块 chips 条（均按需自动隐藏）。 */
  strips: ReactNode;
  /** 终端区浮层：命令块输出过滤面板。 */
  overlay: ReactNode;
}

/**
 * 命令块 chrome 三件套的装配钩子：AgentStatusBar / TerminalBlocksBar /
 * TerminalBlockFilterPanel 曾经写好了逻辑（含测试）却没有挂载点，这里统一
 * 装配并交给 TerminalViewChrome 的两个槽位渲染。拆成独立钩子是为了守住
 * TerminalView 与 TerminalViewChrome 的行数预算（结构回归测试锁定），
 * 纯布局装配，不直接触碰 xterm——数据全部来自 useTerminalBlocks 管道。
 */
export function useTerminalBlocksChrome({ session, blocks, searchOpen }: UseTerminalBlocksChromeOptions): TerminalBlocksChrome {
  // 过滤面板按 block id 引用：块滚出保留窗口被裁剪时，find 落空即自动关闭。
  const [filterBlockId, setFilterBlockId] = useState<string | null>(null);
  const filterBlock = filterBlockId ? blocks.blocks.find((b) => b.id === filterBlockId) ?? null : null;

  return {
    strips: (
      <>
        {session && <AgentStatusBar session={session} />}
        <TerminalBlocksBar
          blocks={blocks.blocks}
          collapsedBlockIds={blocks.collapsedBlockIds}
          stickyBlock={blocks.stickyBlock}
          onCopyCommand={blocks.copyBlockCommand}
          onCopyCommandAndOutput={blocks.copyBlockCommandAndOutput}
          onCopyOutput={blocks.copyBlockOutput}
          onFilterBlock={(block) => setFilterBlockId(block.id)}
          onToggle={blocks.toggleBlock}
          onReveal={blocks.revealBlock}
        />
      </>
    ),
    overlay: filterBlock ? (
      <TerminalBlockFilterPanel
        block={filterBlock}
        output={blocks.readBlockOutput(filterBlock.id) ?? ""}
        topOffset={searchOpen ? 80 : 42}
        onClose={() => setFilterBlockId(null)}
      />
    ) : null,
  };
}
