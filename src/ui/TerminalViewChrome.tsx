import { useEffect, useState, type RefObject } from "react";
import type { ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { ContextMenu } from "./ContextMenu";
import { copyText } from "./lib/clipboard";
import { useT } from "@/modules/i18n";
import type { useTerminalSearch } from "./useTerminalSearch";
import type { useTerminalBlocks } from "./useTerminalBlocks";
import { useTerminalBlocksChrome } from "./useTerminalBlocksChrome";
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
  /** Command-block pipeline from TerminalView; assembled by useTerminalBlocksChrome. */
  blocks: ReturnType<typeof useTerminalBlocks>;
  quickSelectOverlay?: ReactNode;
}

export function TerminalViewChrome({
  sessionId,
  containerRef,
  getTerminal,
  search,
  blocks,
  quickSelectOverlay,
}: TerminalViewChromeProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean; canSplit: boolean } | null>(null);
  const pure = useUIStore((s) => s.presentationMode === "pure");
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId));
  const blocksChrome = useTerminalBlocksChrome({ session, blocks, searchOpen: search.searchOpen });

  useEffect(() => {
    if (!pure) return;
    setMenu(null);
  }, [pure]);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (pure) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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

  // Shift+F10 / ContextMenu 键：右键菜单的键盘入口（WCAG 键盘可操作性）。
  // 菜单锚定在终端区左上内侧，和鼠标右键走同一套菜单状态。
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (pure) return;
    const isMenuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
    if (!isMenuKey) return;
    const term = getTerminal();
    if (!term) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: rect.left + 24,
      y: rect.top + 24,
      hasSelection: !!term.getSelection(),
      canSplit: canSplitLayout(useUIStore.getState().split),
    });
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
      // 剪贴板读取被拒/不可用：静默 catch 用户会以为菜单坏了，给明确反馈
      useUIStore.getState().addToast({
        title: t("term.paste_clipboard_denied"),
        subtitle: "",
        variant: "warning",
      });
    }
  };

  return (
    <div
      style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}
      onContextMenu={handleContextMenu}
      onKeyDown={handleMenuKeyDown}
    >
      {!pure && blocksChrome.strips}
      {/* Search bar / filter panel / quick select anchor to this wrapper so
          they overlay the terminal itself, never the status strips above. */}
      <div style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {!pure && search.searchOpen && (
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
        {!pure && quickSelectOverlay}
        {!pure && blocksChrome.overlay}
      </div>
      {!pure && menu && (
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
