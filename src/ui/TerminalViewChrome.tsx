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
  onCopyBlock: (id: string) => void;
  onToggleBlock: (id: string) => void;
}

export function TerminalViewChrome({
  containerRef,
  search,
  blocks,
  collapsedBlockIds,
  onCopyBlock,
  onToggleBlock,
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
        onCopy={onCopyBlock}
        onToggle={onToggleBlock}
      />
      <div ref={containerRef} style={{ flex: 1, padding: "var(--sp-2)", minHeight: 0 }} />
    </div>
  );
}
