import { Terminal } from "@xterm/xterm";
import { type CursorStyle } from "@/state/ui";
import { type TerminalThemeName, type ThemeType } from "@/ui/types";
import { getTerminalTheme } from "@/styles/terminalTheme";

export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';

interface TerminalInstanceOptions {
  fontSize: number;
  scrollback: number;
  theme: ThemeType;
  terminalTheme: TerminalThemeName;
  accent: string;
  cursorBlink: boolean;
  cursorStyle: CursorStyle;
}

export function createTerminalInstance({
  fontSize,
  scrollback,
  theme,
  terminalTheme,
  accent,
  cursorBlink,
  cursorStyle,
}: TerminalInstanceOptions): Terminal {
  return new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize,
    lineHeight: 1.05,
    theme: getTerminalTheme(theme, terminalTheme, accent),
    cursorBlink,
    cursorStyle,
    cursorInactiveStyle: "outline",
    scrollback,
    allowProposedApi: true,
  });
}
