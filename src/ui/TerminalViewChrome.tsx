import { useState, type RefObject } from "react";
import type { ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { TerminalBlockFilterPanel } from "./TerminalBlockFilterPanel";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalBlocksBar } from "./TerminalBlocksBar";
import { ContextMenu } from "./ContextMenu";
import { copyText } from "./lib/clipboard";
import { useT } from "@/modules/i18n";
import type { useTerminalSearch } from "./useTerminalSearch";
import type { TerminalCommandBlock } from "@/modules/terminal/lib/terminal-blocks";
import { requestProtectedTerminalPaste } from "@/modules/terminal/lib/terminal-paste-protection";

interface TerminalViewChromeProps {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Returns the live xterm instance for copy/paste actions, or null before init. */
  getTerminal: () => Terminal | null;
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
  getTerminal,
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
  const t = useT();
  const [blockFilter, setBlockFilter] = useState<{ block: TerminalCommandBlock; output: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    const term = getTerminal();
    if (!term) return; // before init: let the browser's default menu through (dev only)
    e.preventDefault();
    // xterm's rightClickSelectsWord has already selected the word under the cursor
    // by the time this contextmenu event fires, so getSelection() reflects it.
    setMenu({ x: e.clientX, y: e.clientY, hasSelection: !!term.getSelection() });
  };

  const copySelection = () => {
    const term = getTerminal();
    const sel = term?.getSelection();
    if (sel) void copyText(sel);
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const term = getTerminal();
      if (!term) return;
      const protectedPaste = requestProtectedTerminalPaste(term, text, (message) =>
        tauriConfirmDialog(message, { kind: "warning" }), () => getTerminal() === term);
      if (!protectedPaste) term.paste(text);
    } catch {
      /* clipboard read denied / unavailable */
    }
  };

  return (
    <div
      style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}
      onContextMenu={handleContextMenu}
    >
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
          onClose={() => {
            setBlockFilter(null);
            getTerminal()?.focus();
          }}
        />
      )}
      {quickSelectOverlay}
      {menu && (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            { id: "copy", label: t("term.copy"), icon: "copy", disabled: !menu.hasSelection, action: copySelection },
            { id: "paste", label: t("term.paste"), action: pasteClipboard },
          ]}
        />
      )}
    </div>
  );
}
