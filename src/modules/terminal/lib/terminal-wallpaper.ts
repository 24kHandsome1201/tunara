/**
 * Optional terminal-column wallpaper. Default is off so the solid theme canvas
 * is unchanged. Chrome (sidebar / titlebar / inspector) never uses this layer.
 *
 * Pure helpers stay DOM-free so node tests can pin contrast, veil floors, and
 * the "disabled === previous solid theme" contract.
 */

export const TERMINAL_WALLPAPER_SOURCES = ["paper", "grain", "fiber", "custom"] as const;
export type TerminalWallpaperSource = (typeof TERMINAL_WALLPAPER_SOURCES)[number];

export const MIN_WALLPAPER_BLUR = 0;
export const MAX_WALLPAPER_BLUR = 40;
export const DEFAULT_WALLPAPER_BLUR = 24;
export const MIN_WALLPAPER_VEIL = 50;
export const MAX_WALLPAPER_VEIL = 95;
export const DEFAULT_WALLPAPER_VEIL = 78;
export const WALLPAPER_CONTRAST_FLOOR = 4.5;
export const TRANSPARENT_TERMINAL_BACKGROUND = "#00000000";
const UNKNOWN_WALLPAPER_AVERAGE = "#808080";

export interface TerminalWallpaperSettings {
  enabled: boolean;
  source: TerminalWallpaperSource;
  blur: number;
  veil: number;
}

export const DEFAULT_TERMINAL_WALLPAPER: Readonly<TerminalWallpaperSettings> = {
  enabled: false,
  source: "paper",
  blur: DEFAULT_WALLPAPER_BLUR,
  veil: DEFAULT_WALLPAPER_VEIL,
};

export function isTerminalWallpaperSource(value: unknown): value is TerminalWallpaperSource {
  return typeof value === "string" && (TERMINAL_WALLPAPER_SOURCES as readonly string[]).includes(value);
}

export function clampWallpaperBlur(value: unknown, fallback = DEFAULT_WALLPAPER_BLUR): number {
  return clampInt(value, MIN_WALLPAPER_BLUR, MAX_WALLPAPER_BLUR, fallback);
}

export function clampWallpaperVeil(value: unknown, fallback = DEFAULT_WALLPAPER_VEIL): number {
  return clampInt(value, MIN_WALLPAPER_VEIL, MAX_WALLPAPER_VEIL, fallback);
}

export function sanitizeTerminalWallpaper(raw: {
  enabled?: unknown;
  source?: unknown;
  blur?: unknown;
  veil?: unknown;
} | undefined): TerminalWallpaperSettings {
  return {
    enabled: raw?.enabled === true,
    source: isTerminalWallpaperSource(raw?.source) ? raw.source : DEFAULT_TERMINAL_WALLPAPER.source,
    blur: clampWallpaperBlur(raw?.blur),
    veil: clampWallpaperVeil(raw?.veil),
  };
}

export interface WallpaperResolveInput extends TerminalWallpaperSettings {
  themeBackground: string;
  themeForeground: string;
  isDarkTheme: boolean;
  reducedTransparency: boolean;
  /** Sampled average of the custom photo, when known. */
  customAverage?: string | null;
  /** True when a custom file is actually loaded. Missing custom falls back to veil-only. */
  customReady?: boolean;
}

export interface WallpaperLayer {
  /** False means the terminal must use the unchanged solid theme background. */
  active: boolean;
  source: TerminalWallpaperSource | null;
  blur: number;
  veil: number;
  veilRaised: boolean;
  xtermBackground: string;
  veilFill: string;
  tile: boolean;
}

export function resolveWallpaperLayer(input: WallpaperResolveInput): WallpaperLayer {
  const blur = clampWallpaperBlur(input.blur);
  const requestedVeil = clampWallpaperVeil(input.veil);
  if (!input.enabled || input.reducedTransparency) {
    return inactiveLayer(input.themeBackground, blur, requestedVeil);
  }

  const source = input.source === "custom" && input.customReady !== true ? null : input.source;
  const floor = veilFloor(source ?? "custom", input.isDarkTheme);
  const wallpaperAverage = source === "custom"
    ? (input.customAverage && parseHexColor(input.customAverage) ? input.customAverage : UNKNOWN_WALLPAPER_AVERAGE)
    : textureAverage(source ?? "paper", input.isDarkTheme);
  const contrastVeil = raiseVeilForContrast(
    input.themeForeground,
    input.themeBackground,
    wallpaperAverage,
    Math.max(requestedVeil, floor),
  );
  const veil = clampWallpaperVeil(contrastVeil, requestedVeil);

  return {
    active: true,
    source,
    blur,
    veil,
    veilRaised: veil > requestedVeil,
    xtermBackground: TRANSPARENT_TERMINAL_BACKGROUND,
    veilFill: colorMix(input.themeBackground, veil),
    tile: source !== "custom" && source !== null,
  };
}

export function wallpaperUsesTransparency(layer: WallpaperLayer): boolean {
  return layer.active;
}

export function applyWallpaperToTerminalTheme<T extends { background: string }>(theme: T, layer: WallpaperLayer): T {
  if (!layer.active) return theme;
  return { ...theme, background: layer.xtermBackground };
}

export function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function mixHex(base: string, overlay: string, overlayPercent: number): string {
  const a = parseHexColor(base);
  const b = parseHexColor(overlay);
  if (!a || !b) return overlay;
  const t = Math.min(100, Math.max(0, overlayPercent)) / 100;
  const mix = (x: number, y: number) => Math.round(x * (1 - t) + y * t);
  return `#${[mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b)].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export function contrastRatio(a: string, b: string): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  if (left == null || right == null) return 1;
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

function inactiveLayer(themeBackground: string, blur: number, veil: number): WallpaperLayer {
  return {
    active: false,
    source: null,
    blur,
    veil,
    veilRaised: false,
    xtermBackground: themeBackground,
    veilFill: themeBackground,
    tile: false,
  };
}

function veilFloor(source: TerminalWallpaperSource, isDark: boolean): number {
  if (isDark) return source === "custom" ? 70 : 62;
  return source === "custom" ? 82 : 74;
}

function textureAverage(source: Exclude<TerminalWallpaperSource, "custom">, isDark: boolean): string {
  if (isDark) {
    if (source === "paper") return "#3a342e";
    if (source === "fiber") return "#2c2a28";
    return "#32302e";
  }
  if (source === "paper") return "#d8cfc4";
  if (source === "fiber") return "#cfc8c0";
  return "#c8c4be";
}

function raiseVeilForContrast(
  foreground: string,
  themeBackground: string,
  wallpaperAverage: string,
  start: number,
): number {
  let veil = start;
  while (veil < MAX_WALLPAPER_VEIL) {
    const effective = mixHex(wallpaperAverage, themeBackground, veil);
    if (contrastRatio(foreground, effective) >= WALLPAPER_CONTRAST_FLOOR) return veil;
    veil += 1;
  }
  return MAX_WALLPAPER_VEIL;
}

function relativeLuminance(hex: string): number | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function colorMix(themeBackground: string, veil: number): string {
  return `color-mix(in srgb, ${themeBackground} ${veil}%, transparent)`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
