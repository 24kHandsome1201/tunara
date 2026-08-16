import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { ContextMenu } from "./ContextMenu";
import { useT } from "@/modules/i18n";
import type { useTerminalSearch } from "./useTerminalSearch";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { canSplitLayout } from "@/modules/session/split-layout";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { readyBindingForSession } from "@/modules/terminal/lib/connection-state";
import { terminalUploadDestination } from "@/modules/ssh/remote-cwd";
import { classifyTransferDrop, expandFolderTransfer } from "@/modules/ssh/transfer-intent";
import { validateManifest } from "@/modules/ssh/transfer-bridge";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { fsReadDir } from "@/modules/fs/fs-bridge";
import { TerminalInputRouter, type TerminalInputEventKind, type TerminalInputOwner, type TerminalMouseTrackingMode } from "@/modules/terminal/lib/terminal-input-router";
import { issueFocusReturnToken, type TerminalFocusReturnToken } from "@/modules/terminal/lib/binding-aware-async-action";
import { copyActiveTerminal, registerTerminalMenuAction, safePasteActiveTerminal } from "@/modules/terminal/lib/terminal-action-registry";
import { isFixedTerminalMenuEvent } from "@/modules/config/keybindings";

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
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean; canSplit: boolean; focusToken: TerminalFocusReturnToken | null } | null>(null);
  const pure = useUIStore((s) => s.presentationMode === "pure");
  const hostModifier = useUIStore((s) => s.terminalHostModifier);
  const secondaryClickMode = useUIStore((s) => s.terminalSecondaryClick);
  const inputRouter = useRef(new TerminalInputRouter());
  const contextMenuOwners = useRef(new WeakMap<Event, TerminalInputOwner>());

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
      hostModifier, secondaryClickMode,
      modifiers: { shift: event.shiftKey, meta: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey },
      button: "button" in event ? event.button : undefined,
    });
  };

  const captureRightGesture = (kind: TerminalInputEventKind) => (event: React.MouseEvent) => {
    if (event.button !== 2 || !isOnTerminalCanvas(event)) return;
    const owner = ownerFor(kind, event);
    if (kind === "mouse-down") {
      const term = getTerminal();
      // xterm handles rightClickSelectsWord on contextmenu in desktop WebViews,
      // but on Firefox it runs from mousedown. Disable that host-only behavior
      // before a TUI-owned down reaches xterm, then restore it on the next
      // host-owned gesture. This keeps one gesture from acting on both sides.
      if (term) term.options.rightClickSelectsWord = owner === "tunara";
    }
    if (owner === "tui") return;
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    if (!pure) return;
    setMenu(null);
  }, [pure]);

  const openMenu = useCallback((x: number, y: number) => {
    if (useUIStore.getState().presentationMode === "pure") return;
    const term = getTerminal();
    if (!term) return;
    setMenu({
      x,
      y,
      hasSelection: !!term.getSelection(),
      canSplit: canSplitLayout(useUIStore.getState().split),
      focusToken: issueFocusReturnToken(sessionId),
    });
  }, [getTerminal, sessionId]);

  const openKeyboardMenu = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu(rect.left + 24, rect.top + 24);
  }, [containerRef, openMenu]);

  useEffect(() => registerTerminalMenuAction(sessionId, openKeyboardMenu), [openKeyboardMenu, sessionId]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handleDragDrop = (event: Parameters<Parameters<ReturnType<typeof getCurrentWebview>["onDragDropEvent"]>[0]>[0]) => {
      if (disposed) return;
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      const rect = containerRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      const inside = rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (!inside) return;
      const session = useSessionsStore.getState().sessions.find((item) => item.id === sessionId);
      const binding = readyBindingForSession(session);
      if (!session?.remote || !binding) return;
      const cwd = session.dir;
      void (async () => {
        const requests = [];
        for (const localPath of paths) {
          let isDirectory = false;
          try {
            await fsReadDir(localPath, false);
            isDirectory = true;
          } catch {
            // Ordinary files fail directory listing and continue as uploads.
          }
          const intent = classifyTransferDrop({ localPaths: [localPath], folder: isDirectory });
          if (intent.kind === "folder") {
            const leaf = intent.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "upload";
            const destinationRoot = terminalUploadDestination(cwd, leaf);
            if (!destinationRoot) throw new Error("cwd");
            const manifest = await validateManifest({ kind: "local", root: intent.root });
            const plan = expandFolderTransfer({
              manifest, binding, direction: "upload", sourceRoot: intent.root, destinationRoot, conflict: "rename",
            });
            requests.push(...plan.requests);
          } else {
            const leaf = localPath.split(/[\\/]/).pop() ?? "upload";
            const destination = terminalUploadDestination(cwd, leaf);
            if (!destination) throw new Error("cwd");
            requests.push({ binding, direction: "upload" as const, source: localPath, destination, conflict: "rename" as const });
          }
        }
        if (requests.length === 0) return;
        useTransferStore.getState().enqueueBatch(requests);
        useUIStore.getState().addToast({
          sessionId,
          title: t("term.drop.upload"),
          subtitle: t("explorer.download.batch_queued_hint", { count: requests.length }),
          variant: "success",
        });
      })().catch(() => {
        const hasCwd = terminalUploadDestination(cwd, "file") !== null;
        useUIStore.getState().addToast({
          sessionId,
          title: t("term.drop.upload"),
          subtitle: t(hasCwd ? "explorer.drop.failed" : "term.drop.no_cwd"),
          variant: "error",
        });
      });
    };
    try {
      void getCurrentWebview().onDragDropEvent(handleDragDrop)
        .then((next) => { if (disposed) next(); else unlisten = next; })
        .catch(() => {});
    } catch {
      // Browser/unit-test environments have no current Tauri webview.
    }
    return () => { disposed = true; unlisten?.(); };
  }, [containerRef, sessionId, t]);

  const handleContextMenuCapture = (e: React.MouseEvent) => {
    if (!isOnTerminalCanvas(e)) return;
    const owner = ownerFor("contextmenu", e);
    contextMenuOwners.current.set(e.nativeEvent, owner);
    const term = getTerminal();
    if (term) term.options.rightClickSelectsWord = owner === "tunara";
    if (owner === "tui") {
      // Stop before xterm's bubble-phase rightClickSelectsWord handler. The PTY
      // already owns the latched down/up stream; host selection here would make
      // one gesture execute on both sides.
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!isOnTerminalCanvas(e)) return;
    const owner = contextMenuOwners.current.get(e.nativeEvent) ?? ownerFor("contextmenu", e);
    contextMenuOwners.current.delete(e.nativeEvent);
    if (owner === "tui") {
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
    e.stopPropagation();
    // xterm's rightClickSelectsWord has already selected the word under the cursor
    // by the time this contextmenu event fires, so getSelection() reflects it.
    // Capture split capability together with this pane's session id. Like HerdR,
    // the eventual action must not infer its target from whichever pane is active.
    openMenu(e.clientX, e.clientY);
  };

  // Shift+F10 / ContextMenu 键：右键菜单的键盘入口（WCAG 键盘可操作性）。
  // 菜单锚定在终端区左上内侧，和鼠标右键走同一套菜单状态。
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (pure) return;
    if (!isFixedTerminalMenuEvent(e)) return;
    e.preventDefault();
    openKeyboardMenu();
  };

  return (
    <div
      style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}
      onContextMenu={handleContextMenu}
      onContextMenuCapture={handleContextMenuCapture}
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
            { id: "copy", label: t("term.copy"), icon: "copy", disabled: !menu.hasSelection, action: () => { copyActiveTerminal(sessionId); } },
            { id: "paste", label: t("pure.action.safe_paste"), action: () => { void safePasteActiveTerminal(sessionId); } },
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
            {
              id: "broadcast",
              label: useUIStore.getState().broadcastInput ? t("term.broadcast.off") : t("term.broadcast.on"),
              action: () => useUIStore.getState().toggleBroadcastInput(),
            },
          ]}
        />
      )}
    </div>
  );
}
