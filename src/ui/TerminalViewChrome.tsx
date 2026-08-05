import { useEffect, useRef, useState, type RefObject } from "react";
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
import { TerminalInputRouter, type TerminalInputEventKind, type TerminalMouseTrackingMode } from "@/modules/terminal/lib/terminal-input-router";
import { issueFocusReturnToken, type TerminalFocusReturnToken } from "@/modules/terminal/lib/binding-aware-async-action";

interface TerminalViewChromeProps {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  /** Returns the live xterm instance for copy/paste actions, or null before init. */
  getTerminal: () => Terminal | null;
  search: ReturnType<typeof useTerminalSearch>;
  capturePasteTarget: (terminal: Terminal) => () => boolean;
  quickSelectOverlay?: ReactNode;
}

export function TerminalViewChrome({
  sessionId,
  containerRef,
  getTerminal,
  search,
  capturePasteTarget,
  quickSelectOverlay,
}: TerminalViewChromeProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean; canSplit: boolean; focusToken: TerminalFocusReturnToken | null } | null>(null);
  const pure = useUIStore((s) => s.presentationMode === "pure");
  const hostModifier = useUIStore((s) => s.terminalHostModifier);
  const inputRouter = useRef(new TerminalInputRouter());

  const isOnTerminalCanvas = (event: React.SyntheticEvent) =>
    event.target instanceof Node && !!containerRef.current?.contains(event.target);

  const ownerFor = (kind: TerminalInputEventKind, event: React.MouseEvent | React.WheelEvent) => {
    const term = getTerminal();
    // xterm 6 exposes this publicly; the narrow shape keeps older declarations compatible.
    const mode = (term?.modes as (Terminal["modes"] & { mouseTrackingMode?: string }) | undefined)?.mouseTrackingMode ?? "none";
    return inputRouter.current.route({
      kind, mouseTrackingMode: mode as TerminalMouseTrackingMode,
      selection: !!term?.hasSelection(), pure,
      platform: /Mac/.test(navigator.platform) ? "macos" : /Win/.test(navigator.platform) ? "windows" : "linux",
      hostModifier,
      modifiers: { shift: event.shiftKey, meta: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey },
      button: "button" in event ? event.button : undefined,
    });
  };

  const captureRightGesture = (kind: TerminalInputEventKind) => (event: React.MouseEvent) => {
    if (event.button !== 2 || !isOnTerminalCanvas(event)) return;
    if (ownerFor(kind, event) === "tui") return;
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    if (!pure) return;
    setMenu(null);
  }, [pure]);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!isOnTerminalCanvas(e)) return;
    if (ownerFor("contextmenu", e) === "tui") {
      // xterm owns the already-delivered mouse gesture, but the WebView must
      // not add its native context menu on top of the TUI response.
      e.preventDefault();
      return;
    }
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
      focusToken: issueFocusReturnToken(sessionId),
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
      focusToken: issueFocusReturnToken(sessionId),
    });
  };

  const pasteClipboard = async () => {
    const term = getTerminal();
    if (!term) return;
    const isCurrent = capturePasteTarget(term);
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !isCurrent()) return;
      const protectedPaste = requestProtectedTerminalPaste(term, text, (message) =>
        tauriConfirmDialog(message, { kind: "warning" }), isCurrent);
      if (!protectedPaste && isCurrent()) term.paste(text);
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
      onMouseDownCapture={captureRightGesture("mouse-down")}
      onMouseUpCapture={captureRightGesture("mouse-up")}
      onKeyDown={handleMenuKeyDown}
    >
      {/* Search and quick select stay anchored to the terminal surface. */}
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
        <div data-terminal-canvas ref={containerRef} style={{ flex: 1, padding: "var(--sp-2)", minHeight: 0 }} />
        {!pure && quickSelectOverlay}
      </div>
      {!pure && menu && (
        <ContextMenu
          position={{ x: menu.x, y: menu.y }}
          terminalFocusReturnToken={menu.focusToken}
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
