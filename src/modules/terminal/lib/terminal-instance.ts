import { Terminal, type ILinkHandler } from "@xterm/xterm";
import type { CursorStyle } from "@/state/ui";
import type { TerminalThemeName, ThemeType } from "@/ui/types";
import { getTerminalTheme } from "@/styles/terminalTheme";
import { withAtlasIsolationFontFamily } from "./terminal-atlas-isolation.ts";
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
  screenReaderMode: boolean;
  atlasIsolationKey?: string;
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
  screenReaderMode,
  atlasIsolationKey,
  linkHandler,
}: TerminalInstanceOptions): Terminal {
  return new Terminal({
    fontFamily: withAtlasIsolationFontFamily(
      buildTerminalFontFamily(fontFamily, nerdFontFallback),
      atlasIsolationKey,
    ),
    fontSize,
    lineHeight: 1.05,
    theme: getTerminalTheme(theme, terminalTheme, accent),
    cursorBlink,
    cursorStyle,
    cursorInactiveStyle: "outline",
    screenReaderMode,
    scrollback,
    wordSeparator: " ()[]{}'\";,",
    // Right-click selects the word under the cursor (iTerm/Terminal.app behaviour)
    // when there's no existing selection, so the context-menu Copy targets it.
    rightClickSelectsWord: true,
    allowProposedApi: true,
    linkHandler,
  });
}
