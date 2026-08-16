import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { PtySession } from "@/modules/terminal/lib/pty-bridge";
import { useUIStore, type CursorStyle } from "@/state/ui";
import type { TerminalThemeName, ThemeType } from "./types";
import { getTerminalTheme } from "@/styles/terminalTheme";
import { requestGlobalTerminalAtlasRebuild } from "@/modules/terminal/lib/terminal-atlas-refresh";
import { withAtlasIsolationFontFamily } from "@/modules/terminal/lib/terminal-atlas-isolation";
import { buildTerminalFontFamily } from "@/modules/terminal/lib/terminal-font";
import { issueFocusReturnToken, runBindingAwareContinuation, setLogicalActiveTerminalPane } from "@/modules/terminal/lib/binding-aware-async-action";

const INACTIVE_SCROLLBACK_LIMIT = 1000;

interface TerminalRuntimeSyncOptions {
  sessionId: string;
  active: boolean;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  ptyRef: RefObject<PtySession | null>;
  fontSize: number;
  fontFamily: string;
  nerdFontFallback: boolean;
  scrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  screenReaderMode: boolean;
  theme: ThemeType;
  terminalTheme: TerminalThemeName;
  accent: string;
}

export function useTerminalRuntimeSync({
  sessionId,
  active,
  termRef,
  fitRef,
  ptyRef,
  fontSize,
  fontFamily,
  nerdFontFallback,
  scrollback,
  cursorStyle,
  cursorBlink,
  screenReaderMode,
  theme,
  terminalTheme,
  accent,
}: TerminalRuntimeSyncOptions) {
  const presentationMode = useUIStore((s) => s.presentationMode);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const pty = ptyRef.current;
    if (!term || !fit) return;
    setLogicalActiveTerminalPane(sessionId);
    const token = issueFocusReturnToken(sessionId);
    const timer = setTimeout(() => {
      if (token && !runBindingAwareContinuation(token, () => {})) return;
      try {
        fit.fit();
        pty?.resize(term.cols, term.rows).catch(() => {});
        term.focus();
      } catch {
        /* noop */
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [active, fitRef, presentationMode, ptyRef, sessionId, termRef]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    const effectiveScrollback = active ? scrollback : Math.min(scrollback, INACTIVE_SCROLLBACK_LIMIT);
    term.options.fontFamily = withAtlasIsolationFontFamily(
      buildTerminalFontFamily(fontFamily, nerdFontFallback),
      sessionId,
    );
    term.options.fontSize = fontSize;
    term.options.scrollback = effectiveScrollback;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.screenReaderMode = screenReaderMode;
    term.options.theme = getTerminalTheme(theme, terminalTheme, accent);
    try {
      fit?.fit();
      if (active && ptyRef.current) ptyRef.current.resize(term.cols, term.rows).catch(() => {});
      // Font, colour, and cursor changes invalidate every glyph baked into the
      // WebGL texture atlas. fit() only rebuilds the atlas when the cell grid
      // actually changes size, so a same-size font/theme swap leaves stale
      // glyphs until the next resize. Force a rebuild here. No-op under DOM.
      // The WebGL atlas is shared by terminals with the same font config. Clear
      // every live renderer synchronously; rebuilding only this pane can leave
      // an inactive pane holding the previous palette in the shared cache.
      requestGlobalTerminalAtlasRebuild();
      // WebKitGTK's WebGL renderer can otherwise keep the previous theme's
      // clear color until a later resize or settings change. Repaint the
      // current buffer after rebuilding so palette switches are not one step
      // behind the surrounding shell.
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    } catch {
      /* noop */
    }
  }, [active, accent, cursorBlink, cursorStyle, fitRef, fontFamily, fontSize, nerdFontFallback, ptyRef, screenReaderMode, scrollback, termRef, terminalTheme, theme]);
}
