import type { ThemeType } from "@/ui/types";

/**
 * 默认「纸面 / 暖墨」终端调色板。背景与前景直接取 tokens.css 的主纸面
 * （--c-bg-white）与主墨色（--c-text-primary）的 sRGB 等效值，终端画布与
 * 界面外壳同源，WebGL 渲染时与侧栏、标题栏之间没有冷暖或明度接缝。
 * ANSI 色相在保持辨认度的前提下向暖纸/暖墨调和：常规色与白底对比度
 * ≥ 4.4:1（接近 AA），亮色组保持可区分的同时不荧光。
 */
export const LIGHT_THEME = {
  background: "#fffdfb",
  foreground: "#241e1a",
  cursor: "#241e1a",
  cursorAccent: "#fffdfb",
  selectionBackground: "#c2683c44",
  black: "#3a332a", red: "#b3261e", green: "#2e7d32", yellow: "#8f6200",
  blue: "#1a5fb4", magenta: "#8e3fa8", cyan: "#006b75", white: "#efe9e0",
  brightBlack: "#6f675b", brightRed: "#c5221f", brightGreen: "#188038", brightYellow: "#b06000",
  brightBlue: "#1967d2", brightMagenta: "#a142f4", brightCyan: "#0f9aa6", brightWhite: "#ffffff",
};

export const DARK_THEME = {
  background: "#0f0b09",
  foreground: "#e6e0dc",
  cursor: "#e6e0dc",
  cursorAccent: "#0f0b09",
  selectionBackground: "#e0907066",
  black: "#4a4238", red: "#f47067", green: "#8edb8c", yellow: "#e3b341",
  blue: "#6ea8fe", magenta: "#d2a8ff", cyan: "#56d4dd", white: "#e8e2d8",
  brightBlack: "#8a8175", brightRed: "#ff938a", brightGreen: "#a9f0a4", brightYellow: "#ffcf5c",
  brightBlue: "#96c0ff", brightMagenta: "#e2c5ff", brightCyan: "#7ee7ef", brightWhite: "#fdfbf7",
};

/** Named terminal palettes that used to tint the shell. Cleared on every
 *  theme apply so an upgraded session cannot keep Catppuccin / Tokyo Night
 *  inline tokens after those presets were removed. */
export const SHELL_TINT_KEYS: readonly string[] = Object.freeze([
  "--c-bg-white", "--c-bg-1", "--c-bg-2", "--c-bg-3", "--c-bg-hover",
  "--c-border-1", "--c-border-2", "--c-border-3", "--c-control-border",
  "--c-text-primary", "--c-text-2", "--c-text-3", "--c-text-4",
  "--c-text-5", "--c-text-6", "--c-text-7",
  "--c-bg-white-glass", "--c-bg-1-glass", "--c-bg-2-glass", "--c-bg-glass-fallback",
]);

export function isDarkTheme(theme: ThemeType): boolean {
  if (theme === "dark") return true;
  if (theme === "system") return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return false;
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

export function getSearchDecorations(appTheme: ThemeType) {
  return isDarkTheme(appTheme) ? SEARCH_DECORATIONS_DARK : SEARCH_DECORATIONS_LIGHT;
}

// xterm 按单元格实际背景提升前景对比度。亮底 TUI 常用「常规色底 + 亮色字」
// 标记选中行（如 HerdR 的青底亮青字），没有下限时两者几乎同色不可读。
// 3:1 保证这类组合可读，又不压暗亮色组在画布上的层次（亮色组 ≥ 3:1）。
// 深色调色板刻意保留低对比的 black 槽位，不启用。
const LIGHT_MINIMUM_CONTRAST_RATIO = 3;
const DARK_MINIMUM_CONTRAST_RATIO = 1;

export function getTerminalMinimumContrastRatio(appTheme: ThemeType): number {
  return isDarkTheme(appTheme) ? DARK_MINIMUM_CONTRAST_RATIO : LIGHT_MINIMUM_CONTRAST_RATIO;
}

export function getTerminalTheme(appTheme: ThemeType, accent?: string) {
  const base = isDarkTheme(appTheme) ? DARK_THEME : LIGHT_THEME;
  if (accent) {
    const dark = isDarkTheme(appTheme);
    return { ...base, selectionBackground: accent + (dark ? "66" : "44") };
  }
  return base;
}
