import type { ThemeType } from "../ui/types.ts";
import { SHELL_TINT_KEYS } from "./terminalTheme.ts";

/** localStorage key read by the synchronous index.html boot script. */
export const BOOT_APPEARANCE_STORAGE_KEY = "tunara.boot.appearance";

/** Deleted named terminal palettes. Old boot caches that still store these
 *  must fall back to System without applying a missing tint map. */
export const REMOVED_TERMINAL_THEMES: readonly string[] = Object.freeze([
  "catppuccin",
  "tokyo-night",
  "one-dark",
  "solarized",
  "github-light",
  "rose-pine-dawn",
]);

export const DEFAULT_ACCENT = "#c2683c";

export interface BootAppearance {
  theme: ThemeType;
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

function resolveDark(theme: ThemeType, systemDark: boolean): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return systemDark;
}

function isTheme(value: unknown): value is ThemeType {
  return value === "light" || value === "dark" || value === "system";
}

function sanitizeBootTheme(theme: unknown, terminalTheme: unknown): ThemeType {
  if (typeof terminalTheme === "string" && (REMOVED_TERMINAL_THEMES as readonly string[]).includes(terminalTheme)) {
    return "system";
  }
  return isTheme(theme) ? theme : "system";
}

function sanitizeBootAccent(_accent: unknown): string {
  return DEFAULT_ACCENT;
}

/** Apply dark class + accent vars to `root`. Named-theme shell tints are gone;
 *  leftover inline tokens from a previous version are stripped. */
export function applyBootShellTint(
  root: HTMLElement,
  theme: ThemeType,
  accent: string,
  systemDark = typeof window !== "undefined" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false),
): void {
  const style = root.style;
  for (const key of SHELL_TINT_KEYS) style.removeProperty(key);

  const dark = resolveDark(theme, systemDark);
  root.classList.toggle("dark", dark);

  const nextAccent = sanitizeBootAccent(accent);
  style.setProperty("--c-accent", nextAccent);
  for (const [k, v] of Object.entries(deriveAccentVars(nextAccent, dark))) style.setProperty(k, v);
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
    const parsed = JSON.parse(raw) as Partial<BootAppearance> & { terminalTheme?: string };
    if (typeof parsed.theme !== "string" && typeof parsed.terminalTheme !== "string") {
      return null;
    }
    return {
      theme: sanitizeBootTheme(parsed.theme, parsed.terminalTheme),
      accent: sanitizeBootAccent(parsed.accent),
    };
  } catch {
    return null;
  }
}

/** Inline script body injected into index.html by the Vite plugin (no module graph). */
export function renderBootInlineScript(): string {
  return `
          var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          var stored = null;
          try {
            var raw = localStorage.getItem(${JSON.stringify(BOOT_APPEARANCE_STORAGE_KEY)});
            if (raw) stored = JSON.parse(raw);
          } catch (e) {}
          var REMOVED = ${JSON.stringify(REMOVED_TERMINAL_THEMES)};
          var theme = stored && stored.theme ? stored.theme : "system";
          var terminalTheme = stored && stored.terminalTheme ? stored.terminalTheme : "default";
          if (REMOVED.indexOf(terminalTheme) !== -1) theme = "system";
          if (theme !== "light" && theme !== "dark" && theme !== "system") theme = "system";
          var accent = ${JSON.stringify(DEFAULT_ACCENT)};
          var SHELL_TINT_KEYS = ${JSON.stringify(SHELL_TINT_KEYS)};
          var root = document.documentElement;
          var style = root.style;
          for (var i = 0; i < SHELL_TINT_KEYS.length; i++) style.removeProperty(SHELL_TINT_KEYS[i]);
          var dark = theme === "dark" ? true : theme === "light" ? false : systemDark;
          root.classList.toggle("dark", dark);
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
          style.setProperty("--c-accent-selection", accent + (dark ? "66" : "44"));
        `.trim();
}

