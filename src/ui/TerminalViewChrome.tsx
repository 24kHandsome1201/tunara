import type { RefObject } from "react";
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
  onCopyBlock: (id: string) => void;
  onToggleBlock: (id: string) => void;
  onRevealBlock: (id: string) => void;
}

export function TerminalViewChrome({
  containerRef,
  search,
  blocks,
  collapsedBlockIds,
  stickyBlock,
  onCopyBlock,
  onToggleBlock,
  onRevealBlock,
}: TerminalViewChromeProps) {
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
        onCopy={onCopyBlock}
        onToggle={onToggleBlock}
        onReveal={onRevealBlock}
      />
      <div ref={containerRef} style={{ flex: 1, padding: "var(--sp-2)", minHeight: 0 }} />
    </div>
  );
}
