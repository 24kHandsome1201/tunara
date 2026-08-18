import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWallpaperToTerminalTheme,
  contrastRatio,
  DEFAULT_TERMINAL_WALLPAPER,
  mixHex,
  resolveWallpaperLayer,
  sanitizeTerminalWallpaper,
  TRANSPARENT_TERMINAL_BACKGROUND,
} from "../src/modules/terminal/lib/terminal-wallpaper.ts";
import { wallpaperTextureUrl } from "../src/modules/terminal/lib/terminal-wallpaper-textures.ts";

test("wallpaper is off by default and unknown config stays off", () => {
  assert.equal(DEFAULT_TERMINAL_WALLPAPER.enabled, false);
  assert.deepEqual(sanitizeTerminalWallpaper(undefined), DEFAULT_TERMINAL_WALLPAPER);
  assert.equal(sanitizeTerminalWallpaper({ enabled: "yes", source: "video", blur: 99, veil: 1 }).enabled, false);
  assert.equal(sanitizeTerminalWallpaper({ enabled: true, source: "grain", blur: 12, veil: 80 }).source, "grain");
});

test("disabled wallpaper keeps the previous solid theme background", () => {
  const theme = { background: "#fffdfb", foreground: "#241e1a" };
  const layer = resolveWallpaperLayer({
    ...DEFAULT_TERMINAL_WALLPAPER,
    themeBackground: theme.background,
    themeForeground: theme.foreground,
    isDarkTheme: false,
    reducedTransparency: false,
  });
  assert.equal(layer.active, false);
  assert.equal(layer.xtermBackground, "#fffdfb");
  assert.equal(applyWallpaperToTerminalTheme(theme, layer).background, "#fffdfb");
});

test("reduced transparency forces the solid theme even when wallpaper is enabled", () => {
  const layer = resolveWallpaperLayer({
    enabled: true,
    source: "paper",
    blur: 24,
    veil: 78,
    themeBackground: "#0f0b09",
    themeForeground: "#e6e0dc",
    isDarkTheme: true,
    reducedTransparency: true,
  });
  assert.equal(layer.active, false);
  assert.equal(layer.xtermBackground, "#0f0b09");
});

test("enabled wallpaper makes xterm transparent and raises veil on a light busy photo", () => {
  const layer = resolveWallpaperLayer({
    enabled: true,
    source: "custom",
    blur: 24,
    veil: 50,
    themeBackground: "#fffdfb",
    themeForeground: "#241e1a",
    isDarkTheme: false,
    reducedTransparency: false,
    customReady: true,
    customAverage: "#88ccff",
  });
  assert.equal(layer.active, true);
  assert.equal(layer.xtermBackground, TRANSPARENT_TERMINAL_BACKGROUND);
  assert.ok(layer.veil >= 82, `veil ${layer.veil} should meet the light custom floor`);
  assert.equal(layer.veilRaised, true);
  const effective = mixHex("#88ccff", "#fffdfb", layer.veil);
  assert.ok(contrastRatio("#241e1a", effective) >= 4.5);
});

test("built-in textures are data URIs and tile", () => {
  const paper = resolveWallpaperLayer({
    enabled: true,
    source: "paper",
    blur: 18,
    veil: 78,
    themeBackground: "#0f0b09",
    themeForeground: "#e6e0dc",
    isDarkTheme: true,
    reducedTransparency: false,
  });
  assert.equal(paper.tile, true);
  assert.match(wallpaperTextureUrl("paper"), /^data:image\/svg\+xml/);
  assert.match(wallpaperTextureUrl("grain"), /^data:image\/svg\+xml/);
  assert.match(wallpaperTextureUrl("fiber"), /^data:image\/svg\+xml/);
});
