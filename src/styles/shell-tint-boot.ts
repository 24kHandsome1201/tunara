import type { ThemeType, TerminalThemeName } from "../ui/types.ts";
import { SHELL_TINTS, SHELL_TINT_KEYS, getShellTint, isTerminalThemeDark } from "./terminalTheme.ts";

/** localStorage key read by the synchronous index.html boot script. */
export const BOOT_APPEARANCE_STORAGE_KEY = "tunara.boot.appearance";

/** Minimal tint map for boot — same data as `SHELL_TINTS` in terminalTheme.ts. */
export const SHELL_TINTS_BOOT: Readonly<Record<string, Readonly<Record<string, string>>>> = SHELL_TINTS;

/** Terminal presets that force the `.dark` class when selected. */
export const NAMED_DARK_TERMINAL_THEMES: readonly TerminalThemeName[] = [
  "catppuccin",
  "tokyo-night",
  "one-dark",
  "solarized",
] as const;

export interface BootAppearance {
  theme: ThemeType;
  terminalTheme: TerminalThemeName;
  accent: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function mixColor(fg: [number, number, number], bg: [number, number, number], alpha: number): string {
  return rgbToHex(
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  );
}

function deriveAccentVars(accent: string, dark: boolean): Record<string, string> {
  const rgb = hexToRgb(accent);
  const base: [number, number, number] = dark ? [24, 24, 27] : [255, 255, 255];
  return {
    "--c-accent-bg-light": mixColor(rgb, base, dark ? 0.18 : 0.12),
    "--c-accent-bg-soft": mixColor(rgb, base, dark ? 0.10 : 0.06),
    "--c-accent-border": mixColor(rgb, base, dark ? 0.30 : 0.22),
    "--c-accent-selection": accent + (dark ? "66" : "44"),
  };
}

function resolveDark(theme: ThemeType, terminalTheme: TerminalThemeName, systemDark: boolean): boolean {
  if (terminalTheme !== "default") return isTerminalThemeDark(terminalTheme, theme);
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return systemDark;
}

/** Apply shell tint + accent vars to `root` (documentElement at boot or runtime). */
export function applyBootShellTint(
  root: HTMLElement,
  terminalTheme: TerminalThemeName,
  theme: ThemeType,
  accent: string,
  systemDark = typeof window !== "undefined" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false),
): void {
  const tint = terminalTheme !== "default" ? getShellTint(terminalTheme) : undefined;
  const style = root.style;

  for (const key of SHELL_TINT_KEYS) style.removeProperty(key);

  const dark = resolveDark(theme, terminalTheme, systemDark);
  root.classList.toggle("dark", dark);

  if (tint) {
    for (const [k, v] of Object.entries(tint)) style.setProperty(k, v);
  }

  style.setProperty("--c-accent", accent);
  for (const [k, v] of Object.entries(deriveAccentVars(accent, dark))) style.setProperty(k, v);
}

export function persistBootAppearance(appearance: BootAppearance): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BOOT_APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Quota / private mode — boot falls back to defaults.
  }
}

export function readBootAppearance(): BootAppearance | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(BOOT_APPEARANCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BootAppearance>;
    if (
      typeof parsed.theme !== "string" ||
      typeof parsed.terminalTheme !== "string" ||
      typeof parsed.accent !== "string"
    ) {
      return null;
    }
    return {
      theme: parsed.theme as ThemeType,
      terminalTheme: parsed.terminalTheme as TerminalThemeName,
      accent: parsed.accent,
    };
  } catch {
    return null;
  }
}

/** Inline script body injected into index.html by the Vite plugin (no module graph). */
export function renderBootInlineScript(): string {
  const defaultAccent = "#c2683c";
  return `
          var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          var stored = null;
          try {
            var raw = localStorage.getItem(${JSON.stringify(BOOT_APPEARANCE_STORAGE_KEY)});
            if (raw) stored = JSON.parse(raw);
          } catch (e) {}
          var theme = stored && stored.theme ? stored.theme : "system";
          var terminalTheme = stored && stored.terminalTheme ? stored.terminalTheme : "default";
          var accent = stored && stored.accent ? stored.accent : ${JSON.stringify(defaultAccent)};
          var SHELL_TINTS = ${JSON.stringify(SHELL_TINTS_BOOT)};
          var SHELL_TINT_KEYS = ${JSON.stringify(SHELL_TINT_KEYS)};
          var NAMED_DARK = ${JSON.stringify(NAMED_DARK_TERMINAL_THEMES)};
          var root = document.documentElement;
          var style = root.style;
          for (var i = 0; i < SHELL_TINT_KEYS.length; i++) style.removeProperty(SHELL_TINT_KEYS[i]);
          var dark = terminalTheme !== "default"
            ? NAMED_DARK.indexOf(terminalTheme) !== -1
            : theme === "dark" ? true : theme === "light" ? false : systemDark;
          root.classList.toggle("dark", dark);
          if (terminalTheme !== "default" && SHELL_TINTS[terminalTheme]) {
            var tint = SHELL_TINTS[terminalTheme];
            for (var k in tint) {
              if (Object.prototype.hasOwnProperty.call(tint, k)) style.setProperty(k, tint[k]);
            }
          }
          style.setProperty("--c-accent", accent);
          var hex = parseInt(accent.slice(1), 16);
          var ar = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
          var base = dark ? [24, 24, 27] : [255, 255, 255];
          function mix(a, fg, bg) {
            var r = Math.round(fg[0]*a+bg[0]*(1-a)), g = Math.round(fg[1]*a+bg[1]*(1-a)), b = Math.round(fg[2]*a+bg[2]*(1-a));
            return "#" + ((1<<24)|(r<<16)|(g<<8)|b).toString(16).slice(1);
          }
          style.setProperty("--c-accent-bg-light", mix(dark ? 0.18 : 0.12, ar, base));
          style.setProperty("--c-accent-bg-soft", mix(dark ? 0.10 : 0.06, ar, base));
          style.setProperty("--c-accent-border", mix(dark ? 0.30 : 0.22, ar, base));
        `.trim();
}