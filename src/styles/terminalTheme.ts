import type { ThemeType, TerminalThemeName } from "@/ui/types";

export const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#27272a",
  cursor: "#27272a",
  cursorAccent: "#ffffff",
  selectionBackground: "#c2683c44",
  black: "#27272a", red: "#ef4444", green: "#22c55e", yellow: "#eab308",
  blue: "#3b82f6", magenta: "#a855f7", cyan: "#06b6d4", white: "#e4e4e7",
  brightBlack: "#52525b", brightRed: "#f87171", brightGreen: "#4ade80", brightYellow: "#facc15",
  brightBlue: "#60a5fa", brightMagenta: "#c084fc", brightCyan: "#22d3ee", brightWhite: "#fafafa",
};

export const DARK_THEME = {
  background: "#18181b",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#18181b",
  selectionBackground: "#e0907066",
  black: "#3f3f46", red: "#f87171", green: "#4ade80", yellow: "#facc15",
  blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4e7",
  brightBlack: "#52525b", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047",
  brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#fafafa",
};

export const CATPPUCCIN_THEME = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  cursorAccent: "#1e1e2e",
  selectionBackground: "#585b7066",
  black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
  blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
  brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1", brightYellow: "#f9e2af",
  brightBlue: "#89b4fa", brightMagenta: "#f5c2e7", brightCyan: "#94e2d5", brightWhite: "#a6adc8",
};

export const TOKYO_NIGHT_THEME = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#1a1b26",
  selectionBackground: "#33467c66",
  black: "#414868", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
  blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
  brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a", brightYellow: "#e0af68",
  brightBlue: "#7aa2f7", brightMagenta: "#bb9af7", brightCyan: "#7dcfff", brightWhite: "#c0caf5",
};

export const ONE_DARK_THEME = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  cursorAccent: "#282c34",
  selectionBackground: "#3e445166",
  black: "#3f4451", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
  brightBlack: "#4f5666", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#d19a66",
  brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#e6e6e6",
};

export const SOLARIZED_THEME = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#839496",
  cursorAccent: "#002b36",
  selectionBackground: "#07364466",
  black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
  blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
  brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#859900", brightYellow: "#b58900",
  brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
};

export const GITHUB_LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#044289",
  cursorAccent: "#ffffff",
  selectionBackground: "#0969da33",
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
  blue: "#0550ae", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
  brightBlue: "#0969da", brightMagenta: "#8250df", brightCyan: "#3192aa", brightWhite: "#8c959f",
};

export const ROSE_PINE_DAWN_THEME = {
  background: "#faf4ed",
  foreground: "#575279",
  cursor: "#575279",
  cursorAccent: "#faf4ed",
  selectionBackground: "#dfdad944",
  black: "#f2e9e1", red: "#b4637a", green: "#286983", yellow: "#ea9d34",
  blue: "#56949f", magenta: "#907aa9", cyan: "#d7827e", white: "#575279",
  brightBlack: "#9893a5", brightRed: "#b4637a", brightGreen: "#286983", brightYellow: "#ea9d34",
  brightBlue: "#56949f", brightMagenta: "#907aa9", brightCyan: "#d7827e", brightWhite: "#575279",
};

const NAMED_DARK_THEMES: Record<string, typeof DARK_THEME> = {
  catppuccin: CATPPUCCIN_THEME,
  "tokyo-night": TOKYO_NIGHT_THEME,
  "one-dark": ONE_DARK_THEME,
  solarized: SOLARIZED_THEME,
};

const NAMED_LIGHT_THEMES: Record<string, typeof LIGHT_THEME> = {
  "github-light": GITHUB_LIGHT_THEME,
  "rose-pine-dawn": ROSE_PINE_DAWN_THEME,
};

export function isDarkTheme(theme: ThemeType): boolean {
  if (theme === "dark") return true;
  if (theme === "system") return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return false;
}

export function isTerminalThemeDark(terminalTheme: TerminalThemeName, appTheme: ThemeType): boolean {
  if (terminalTheme === "default") return isDarkTheme(appTheme);
  return !!NAMED_DARK_THEMES[terminalTheme];
}

export function getTerminalTheme(appTheme: ThemeType, terminalTheme: TerminalThemeName, accent?: string) {
  let base;
  if (terminalTheme !== "default" && NAMED_DARK_THEMES[terminalTheme]) {
    base = NAMED_DARK_THEMES[terminalTheme];
  } else if (terminalTheme !== "default" && NAMED_LIGHT_THEMES[terminalTheme]) {
    base = NAMED_LIGHT_THEMES[terminalTheme];
  } else {
    base = isDarkTheme(appTheme) ? DARK_THEME : LIGHT_THEME;
  }
  if (accent) {
    const dark = isTerminalThemeDark(terminalTheme, appTheme);
    return { ...base, selectionBackground: accent + (dark ? "66" : "44") };
  }
  return base;
}
