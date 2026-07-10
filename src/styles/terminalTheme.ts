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

/**
 * 外壳染色（shell tinting）：当用户选了非 default 终端预设时，UI 外壳
 * （侧栏 / 面板 / 标题栏 / 命令面板）的中性背景 / 边框 / 文字层级也跟随该
 * 预设的官方调色板，做到整窗视觉统一。仅染中性外壳色，不染语义色
 * （agent 徽章 / diff 红绿 / success-error）与强调色——后两者与预设正交叠加。
 * 详见 docs/THEME_SHELL_TINTING.md。
 */
export const SHELL_TINTS: Record<string, Record<string, string>> = {
  catppuccin: {
    "--c-bg-white": "#11111b", "--c-bg-1": "#1e1e2e", "--c-bg-2": "#181825",
    "--c-bg-3": "#313244", "--c-bg-hover": "#45475a",
    "--c-border-1": "#313244", "--c-border-2": "#45475a", "--c-border-3": "#28283a",
    "--c-text-primary": "#cdd6f4", "--c-text-2": "#bac2de", "--c-text-3": "#a6adc8",
    "--c-text-4": "#9399b2", "--c-text-5": "#7f849c", "--c-text-6": "#6c7086", "--c-text-7": "#585b70",
    "--c-bg-white-glass": "#11111b", "--c-bg-1-glass": "#1e1e2e",
    "--c-bg-2-glass": "#181825", "--c-bg-glass-fallback": "#181825",
  },
  "tokyo-night": {
    "--c-bg-white": "#16161e", "--c-bg-1": "#1a1b26", "--c-bg-2": "#1f2335",
    "--c-bg-3": "#292e42", "--c-bg-hover": "#343a52",
    "--c-border-1": "#292e42", "--c-border-2": "#3b4261", "--c-border-3": "#222230",
    "--c-text-primary": "#c0caf5", "--c-text-2": "#a9b1d6", "--c-text-3": "#9aa5ce",
    "--c-text-4": "#828bb8", "--c-text-5": "#6c7394", "--c-text-6": "#565f89", "--c-text-7": "#414868",
    "--c-bg-white-glass": "#16161e", "--c-bg-1-glass": "#1a1b26",
    "--c-bg-2-glass": "#1f2335", "--c-bg-glass-fallback": "#1f2335",
  },
  "one-dark": {
    "--c-bg-white": "#21252b", "--c-bg-1": "#282c34", "--c-bg-2": "#2c313a",
    "--c-bg-3": "#3b4048", "--c-bg-hover": "#3e4451",
    "--c-border-1": "#3b4048", "--c-border-2": "#4b5263", "--c-border-3": "#31363f",
    "--c-text-primary": "#abb2bf", "--c-text-2": "#9da5b4", "--c-text-3": "#828997",
    "--c-text-4": "#6f7787", "--c-text-5": "#5c6370", "--c-text-6": "#4f5666", "--c-text-7": "#3f4451",
    "--c-bg-white-glass": "#21252b", "--c-bg-1-glass": "#282c34",
    "--c-bg-2-glass": "#2c313a", "--c-bg-glass-fallback": "#2c313a",
  },
  solarized: {
    "--c-bg-white": "#002129", "--c-bg-1": "#002b36", "--c-bg-2": "#073642",
    "--c-bg-3": "#0a4250", "--c-bg-hover": "#0e4a59",
    "--c-border-1": "#073642", "--c-border-2": "#0d4d5c", "--c-border-3": "#05303b",
    "--c-text-primary": "#93a1a1", "--c-text-2": "#839496", "--c-text-3": "#768d8d",
    "--c-text-4": "#6a8080", "--c-text-5": "#586e75", "--c-text-6": "#4a5e64", "--c-text-7": "#3b4d52",
    "--c-bg-white-glass": "#002129", "--c-bg-1-glass": "#002b36",
    "--c-bg-2-glass": "#073642", "--c-bg-glass-fallback": "#073642",
  },
  "github-light": {
    "--c-bg-white": "#ffffff", "--c-bg-1": "#ffffff", "--c-bg-2": "#f6f8fa",
    "--c-bg-3": "#eaeef2", "--c-bg-hover": "#eef1f4",
    "--c-border-1": "#d0d7de", "--c-border-2": "#afb8c1", "--c-border-3": "#e4e8ec",
    "--c-text-primary": "#1f2328", "--c-text-2": "#24292f", "--c-text-3": "#57606a",
    "--c-text-4": "#6e7781", "--c-text-5": "#838c95", "--c-text-6": "#a0a8b0", "--c-text-7": "#bcc4cc",
    "--c-bg-white-glass": "#ffffff", "--c-bg-1-glass": "#ffffff",
    "--c-bg-2-glass": "#f6f8fa", "--c-bg-glass-fallback": "#f6f8fa",
  },
  "rose-pine-dawn": {
    "--c-bg-white": "#fffaf3", "--c-bg-1": "#faf4ed", "--c-bg-2": "#fffaf3",
    "--c-bg-3": "#f2e9e1", "--c-bg-hover": "#f4ede8",
    "--c-border-1": "#f2e9e1", "--c-border-2": "#dfdad9", "--c-border-3": "#f4ede8",
    "--c-text-primary": "#575279", "--c-text-2": "#6e6a86", "--c-text-3": "#797593",
    "--c-text-4": "#8c899f", "--c-text-5": "#9893a5", "--c-text-6": "#b5afb8", "--c-text-7": "#cecacd",
    "--c-bg-white-glass": "#fffaf3", "--c-bg-1-glass": "#faf4ed",
    "--c-bg-2-glass": "#fffaf3", "--c-bg-glass-fallback": "#fffaf3",
  },
};

/** 所有被外壳染色覆写的变量名并集；切回 default 时逐一 removeProperty 让其回落 tokens.css。 */
export const SHELL_TINT_KEYS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(SHELL_TINTS).flatMap((t) => Object.keys(t)))),
);

function getOwnTheme<T>(themes: Record<string, T>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(themes, name) ? themes[name] : undefined;
}

export function getShellTint(terminalTheme: string): Record<string, string> | undefined {
  return getOwnTheme(SHELL_TINTS, terminalTheme);
}

const NAMED_DARK_THEMES: Record<string, typeof DARK_THEME> = {
  catppuccin: CATPPUCCIN_THEME,
  "tokyo-night": TOKYO_NIGHT_THEME,
  "one-dark": ONE_DARK_THEME,
  solarized: SOLARIZED_THEME,
};

/** Keys of terminal presets that force the `.dark` class on the shell.
 *  Shared by the runtime (`isTerminalThemeDark`) and the cold-start boot
 *  script (`shell-tint-boot.ts`) so the two paths never diverge. */
export const NAMED_DARK_TERMINAL_THEME_KEYS: readonly string[] = Object.freeze(
  Object.keys(NAMED_DARK_THEMES),
);

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
  return getOwnTheme(NAMED_DARK_THEMES, terminalTheme) !== undefined;
}

// 终端搜索高亮。xterm 的 decoration 色值走 canvas/WebGL，不吃 CSS 变量，
// 只能在这里按解析后的终端主题明暗二选一。暗底沿用原 #e8a960；亮底同色系
// 加深，否则 44 透明度的浅橙在白底上几乎不可见。
const SEARCH_DECORATIONS_DARK = {
  matchBackground: "#e8a96044",
  matchOverviewRuler: "#e8a960",
  activeMatchBackground: "#e8a960aa",
  activeMatchColorOverviewRuler: "#e8a960",
};

const SEARCH_DECORATIONS_LIGHT = {
  matchBackground: "#d9822b3a",
  matchOverviewRuler: "#d9822b",
  activeMatchBackground: "#d9822b90",
  activeMatchColorOverviewRuler: "#d9822b",
};

export function getSearchDecorations(appTheme: ThemeType, terminalTheme: TerminalThemeName) {
  return isTerminalThemeDark(terminalTheme, appTheme) ? SEARCH_DECORATIONS_DARK : SEARCH_DECORATIONS_LIGHT;
}

export function getTerminalTheme(appTheme: ThemeType, terminalTheme: TerminalThemeName, accent?: string) {
  let base;
  const darkTheme = terminalTheme !== "default" ? getOwnTheme(NAMED_DARK_THEMES, terminalTheme) : undefined;
  const lightTheme = terminalTheme !== "default" ? getOwnTheme(NAMED_LIGHT_THEMES, terminalTheme) : undefined;
  if (darkTheme) {
    base = darkTheme;
  } else if (lightTheme) {
    base = lightTheme;
  } else {
    base = isDarkTheme(appTheme) ? DARK_THEME : LIGHT_THEME;
  }
  if (accent) {
    const dark = isTerminalThemeDark(terminalTheme, appTheme);
    return { ...base, selectionBackground: accent + (dark ? "66" : "44") };
  }
  return base;
}
