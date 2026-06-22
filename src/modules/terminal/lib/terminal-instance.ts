import { Terminal, type ILinkHandler } from "@xterm/xterm";
import { type CursorStyle } from "@/state/ui";
import { type TerminalThemeName, type ThemeType } from "@/ui/types";
import { getTerminalTheme } from "@/styles/terminalTheme";
import { buildTerminalFontFamily } from "./terminal-font.ts";

interface TerminalInstanceOptions {
  fontSize: number;
  fontFamily: string;
  nerdFontFallback: boolean;
  scrollback: number;
  theme: ThemeType;
  terminalTheme: TerminalThemeName;
  accent: string;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
  linkHandler?: ILinkHandler | null;
}

export function createTerminalInstance({
  fontSize,
  fontFamily,
  nerdFontFallback,
  scrollback,
  theme,
  terminalTheme,
  accent,
  cursorBlink,
  cursorStyle,
  linkHandler,
}: TerminalInstanceOptions): Terminal {
  return new Terminal({
    fontFamily: buildTerminalFontFamily(fontFamily, nerdFontFallback),
    fontSize,
    lineHeight: 1.05,
    theme: getTerminalTheme(theme, terminalTheme, accent),
    cursorBlink,
    cursorStyle,
    cursorInactiveStyle: "outline",
    scrollback,
    wordSeparator: " ()[]{}'\";,",
    allowProposedApi: true,
    linkHandler,
  });
}
