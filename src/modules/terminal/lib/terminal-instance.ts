import { Terminal } from "@xterm/xterm";
import { type CursorStyle } from "@/state/ui";
import { type TerminalThemeName, type ThemeType } from "@/ui/types";
import { getTerminalTheme } from "@/styles/terminalTheme";

export const TERMINAL_FONT_FAMILY = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';

function quoteSingleFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (!trimmed) return '"JetBrains Mono"';
  if (trimmed.includes(",") || trimmed.startsWith("\"") || trimmed.startsWith("'")) return trimmed;
  if (/^(monospace|serif|sans-serif|cursive|fantasy|system-ui)$/i.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, "\\\"")}"`;
}

export function buildTerminalFontFamily(fontFamily: string, nerdFontFallback: boolean): string {
  const base = quoteSingleFamily(fontFamily);
  const fallback = nerdFontFallback
    ? '"Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", SFMono-Regular, Menlo, monospace'
    : "SFMono-Regular, Menlo, monospace";
  return `${base}, ${fallback}`;
}

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
  });
}
