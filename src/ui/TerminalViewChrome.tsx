import { useState, type RefObject } from "react";
import type { ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { ContextMenu } from "./ContextMenu";
import { copyText } from "./lib/clipboard";
import { useT } from "@/modules/i18n";
import type { useTerminalSearch } from "./useTerminalSearch";
import { requestProtectedTerminalPaste } from "@/modules/terminal/lib/terminal-paste-protection";
import { canSplitLayout } from "@/modules/session/split-layout";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

interface TerminalViewChromeProps {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Returns the live xterm instance for copy/paste actions, or null before init. */
  getTerminal: () => Terminal | null;
  search: ReturnType<typeof useTerminalSearch>;
  quickSelectOverlay?: ReactNode;
}

export function TerminalViewChrome({
  sessionId,
  containerRef,
  getTerminal,
  search,
  quickSelectOverlay,
}: TerminalViewChromeProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean; canSplit: boolean } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    const term = getTerminal();
    if (!term) return; // before init: let the browser's default menu through (dev only)
    e.preventDefault();
    // xterm's rightClickSelectsWord has already selected the word under the cursor
    // by the time this contextmenu event fires, so getSelection() reflects it.
    // Capture split capability together with this pane's session id. Like HerdR,
    // the eventual action must not infer its target from whichever pane is active.
    setMenu({
      x: e.clientX,
      y: e.clientY,
      hasSelection: !!term.getSelection(),
      canSplit: canSplitLayout(useUIStore.getState().split),
    });
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
      <div ref={containerRef} style={{ flex: 1, padding: "var(--sp-2)", minHeight: 0 }} />
      {quickSelectOverlay}
      {menu && (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={[
            { id: "copy", label: t("term.copy"), icon: "copy", disabled: !menu.hasSelection, action: copySelection },
            { id: "paste", label: t("term.paste"), action: pasteClipboard },
            null,
            {
              id: "split-right",
              label: t("term.new_terminal_right"),
              icon: "terminal",
              disabled: !menu.canSplit,
              action: () => useSessionsStore.getState().splitWithNewSession("horizontal", sessionId),
            },
            {
              id: "split-down",
              label: t("term.new_terminal_down"),
              icon: "terminal",
              disabled: !menu.canSplit,
              action: () => useSessionsStore.getState().splitWithNewSession("vertical", sessionId),
            },
          ]}
        />
      )}
    </div>
  );
}
