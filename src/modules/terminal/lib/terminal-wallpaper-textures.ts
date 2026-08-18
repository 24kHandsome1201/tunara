import type { TerminalWallpaperSource } from "./terminal-wallpaper.ts";

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function noiseSvg(baseFrequency: string, octaves: number): string {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">` +
      `<filter id="n" x="0" y="0" width="100%" height="100%">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="${octaves}" stitchTiles="stitch"/>` +
      `<feColorMatrix type="saturate" values="0"/>` +
      `</filter>` +
      `<rect width="100%" height="100%" filter="url(#n)"/>` +
      `</svg>`,
  );
}

/** Quiet built-in textures. Custom photos are never the default. */
export const TERMINAL_WALLPAPER_TEXTURES: Record<Exclude<TerminalWallpaperSource, "custom">, string> = {
  paper: noiseSvg("0.72", 3),
  grain: noiseSvg("1.15", 4),
  fiber: noiseSvg("0.035 0.85", 2),
};

export function wallpaperTextureUrl(source: Exclude<TerminalWallpaperSource, "custom">): string {
  return TERMINAL_WALLPAPER_TEXTURES[source];
}
