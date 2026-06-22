import { useState, type RefObject } from "react";
import type { ReactNode } from "react";
import { TerminalBlockFilterPanel } from "./TerminalBlockFilterPanel";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalBlocksBar } from "./TerminalBlocksBar";
import type { useTerminalSearch } from "./useTerminalSearch";
import type { TerminalCommandBlock } from "./useTerminalBlocks";

interface TerminalViewChromeProps {
  containerRef: RefObject<HTMLDivElement | null>;
  search: ReturnType<typeof useTerminalSearch>;
  blocks: TerminalCommandBlock[];
  collapsedBlockIds: Record<string, true>;
  stickyBlock: TerminalCommandBlock | null;
  onCopyBlockCommand: (id: string) => boolean | Promise<boolean>;
  onCopyBlockCommandAndOutput: (id: string) => boolean | Promise<boolean>;
  onCopyBlockOutput: (id: string) => boolean | Promise<boolean>;
  onReadBlockOutput: (id: string) => string | null;
  onToggleBlock: (id: string) => void;
  onRevealBlock: (id: string) => void;
  quickSelectOverlay?: ReactNode;
}

export function TerminalViewChrome({
  containerRef,
  search,
  blocks,
  collapsedBlockIds,
  stickyBlock,
  onCopyBlockCommand,
  onCopyBlockCommandAndOutput,
  onCopyBlockOutput,
  onReadBlockOutput,
  onToggleBlock,
  onRevealBlock,
  quickSelectOverlay,
}: TerminalViewChromeProps) {
  const [blockFilter, setBlockFilter] = useState<{ block: TerminalCommandBlock; output: string } | null>(null);
  return (
    <div style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {search.searchOpen && (
        <TerminalSearchBar
          inputRef={search.searchInputRef}
          query={search.searchQuery}
          count={search.searchCount}
          useRegex={search.useRegex}
          caseSensitive={search.caseSensitive}
          onQueryChange={search.handleSearchChange}
          onNext={search.handleSearchNext}
          onPrev={search.handleSearchPrev}
          onClose={search.closeSearch}
          onToggleRegex={search.toggleRegex}
          onToggleCaseSensitive={search.toggleCaseSensitive}
        />
      )}
      <TerminalBlocksBar
        blocks={blocks}
        collapsedBlockIds={collapsedBlockIds}
        stickyBlock={stickyBlock}
        onCopyCommand={onCopyBlockCommand}
        onCopyCommandAndOutput={onCopyBlockCommandAndOutput}
        onCopyOutput={onCopyBlockOutput}
        onFilterBlock={(block) => {
          const output = onReadBlockOutput(block.id);
          if (output === null) return;
          setBlockFilter({ block, output });
        }}
        onToggle={onToggleBlock}
        onReveal={onRevealBlock}
      />
      <div ref={containerRef} style={{ flex: 1, padding: "var(--sp-2)", minHeight: 0 }} />
      {blockFilter && (
        <TerminalBlockFilterPanel
          block={blockFilter.block}
          output={blockFilter.output}
          onClose={() => setBlockFilter(null)}
        />
      )}
      {quickSelectOverlay}
    </div>
  );
}
