import { useEffect, type RefObject } from "react";
import { type Terminal } from "@xterm/xterm";
import { type FitAddon } from "@xterm/addon-fit";
import { type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { type CursorStyle } from "@/state/ui";
import { type TerminalThemeName, type ThemeType } from "./types";
import { getTerminalTheme } from "@/styles/terminalTheme";

interface TerminalRuntimeSyncOptions {
  active: boolean;
  termRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  ptyRef: RefObject<PtySession | null>;
  fontSize: number;
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
  fontSize,
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
    term.options.fontSize = fontSize;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    term.options.theme = getTerminalTheme(theme, terminalTheme, accent);
    try {
      fit?.fit();
      if (active && ptyRef.current) ptyRef.current.resize(term.cols, term.rows).catch(() => {});
    } catch {
      /* noop */
    }
  }, [active, accent, cursorBlink, cursorStyle, fitRef, fontSize, ptyRef, termRef, terminalTheme, theme]);
}
