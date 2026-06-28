import { useEffect, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { PtySession } from "@/modules/terminal/lib/pty-bridge";
import type { CursorStyle } from "@/state/ui";
import type { TerminalThemeName, ThemeType } from "./types";
import type { TerminalWebglRenderer } from "./useTerminalWebgl";
import { getTerminalTheme } from "@/styles/terminalTheme";
import { buildTerminalFontFamily } from "@/modules/terminal/lib/terminal-font";

const INACTIVE_SCROLLBACK_LIMIT = 1000;

interface TerminalRuntimeSyncOptions {
  active: boolean;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  ptyRef: RefObject<PtySession | null>;
  webglRef: RefObject<TerminalWebglRenderer | null>;
  fontSize: number;
  fontFamily: string;
  nerdFontFallback: boolean;
  scrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  theme: ThemeType;
  terminalTheme: TerminalThemeName;
  accent: string;
}

export function useTerminalRuntimeSync({
  active,
  termRef,
  fitRef,
  ptyRef,
  webglRef,
  fontSize,
  fontFamily,
  nerdFontFallback,
  scrollback,
  cursorStyle,
  cursorBlink,
  theme,
  terminalTheme,
  accent,
}: TerminalRuntimeSyncOptions) {
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const pty = ptyRef.current;
    if (!term || !fit) return;
    const timer = setTimeout(() => {
      try {
        fit.fit();
        pty?.resize(term.cols, term.rows).catch(() => {});
        term.focus();
      } catch {
        /* noop */
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [active, fitRef, ptyRef, termRef]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    const effectiveScrollback = active ? scrollback : Math.min(scrollback, INACTIVE_SCROLLBACK_LIMIT);
    term.options.fontFamily = buildTerminalFontFamily(fontFamily, nerdFontFallback);
    term.options.fontSize = fontSize;
    term.options.scrollback = effectiveScrollback;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.theme = getTerminalTheme(theme, terminalTheme, accent);
    try {
      fit?.fit();
      if (active && ptyRef.current) ptyRef.current.resize(term.cols, term.rows).catch(() => {});
      // Font, colour, and cursor changes invalidate every glyph baked into the
      // WebGL texture atlas. fit() only rebuilds the atlas when the cell grid
      // actually changes size, so a same-size font/theme swap leaves stale
      // glyphs until the next resize. Force a rebuild here. No-op under DOM.
      webglRef.current?.clearTextureAtlas();
    } catch {
      /* noop */
    }
  }, [active, accent, cursorBlink, cursorStyle, fitRef, fontFamily, fontSize, nerdFontFallback, ptyRef, scrollback, termRef, terminalTheme, theme, webglRef]);
}
