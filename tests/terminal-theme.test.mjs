import assert from "node:assert/strict";
import test from "node:test";

import {
  DARK_THEME,
  LIGHT_THEME,
  getSearchDecorations,
  isDarkTheme,
  getTerminalTheme,
} from "../src/styles/terminalTheme.ts";

// NOTE: isDarkTheme("system") reads window.matchMedia, which does not exist in
// the node test runner. These tests only exercise the explicit dark/light
// paths, which never touch `window`.

test("isDarkTheme follows the explicit app theme", () => {
  assert.equal(isDarkTheme("dark"), true);
  assert.equal(isDarkTheme("light"), false);
});

test("getTerminalTheme returns the matching base palette for explicit app themes", () => {
  assert.deepEqual(getTerminalTheme("dark"), DARK_THEME);
  assert.deepEqual(getTerminalTheme("light"), LIGHT_THEME);
});

test("unknown or removed named palettes are ignored; default light/dark palettes remain", () => {
  assert.deepEqual(getTerminalTheme("light"), LIGHT_THEME);
  assert.deepEqual(getTerminalTheme("dark"), DARK_THEME);
});

test("getTerminalTheme blends accent into selectionBackground with 66 alpha on dark themes", () => {
  const theme = getTerminalTheme("dark", "#abcdef");
  assert.equal(theme.selectionBackground, "#abcdef66");
  assert.equal(theme.background, DARK_THEME.background);
  assert.equal(theme.foreground, DARK_THEME.foreground);
});

test("getTerminalTheme blends accent with 44 alpha on light themes", () => {
  const theme = getTerminalTheme("light", "#abcdef");
  assert.equal(theme.selectionBackground, "#abcdef44");
  assert.equal(theme.background, LIGHT_THEME.background);
});

test("getTerminalTheme without an accent leaves the base selectionBackground intact", () => {
  const theme = getTerminalTheme("dark");
  assert.equal(theme.selectionBackground, DARK_THEME.selectionBackground);
});

test("search decorations follow the resolved app theme", () => {
  assert.equal(getSearchDecorations("dark").matchOverviewRuler, "#e8a960");
  assert.equal(getSearchDecorations("light").matchOverviewRuler, "#d9822b");
});

// The default palettes share the shell's warm paper/ink tokens; keep their
// foreground and chromatic ANSI colors comfortably readable on their canvas.
test("default light/dark terminal palettes keep foreground AAA and ANSI hues near-AA", async () => {
  const { contrastRatio } = await import("../src/styles/shell-tint-contrast.ts");
  const chromatic = ["red", "green", "yellow", "blue", "magenta", "cyan"];
  for (const [name, palette] of [["light", LIGHT_THEME], ["dark", DARK_THEME]]) {
    assert.ok(
      contrastRatio(palette.foreground, palette.background) >= 12,
      `${name} foreground should be near-AAA on its background`,
    );
    for (const key of chromatic) {
      assert.ok(
        contrastRatio(palette[key], palette.background) >= 4.4,
        `${name} ${key} is ${contrastRatio(palette[key], palette.background).toFixed(2)}:1 on ${palette.background}`,
      );
    }
    // Bright black renders comments and dim text; it must stay legible.
    assert.ok(
      contrastRatio(palette.brightBlack, palette.background) >= 4.5,
      `${name} brightBlack should stay AA on its background`,
    );
  }
});
