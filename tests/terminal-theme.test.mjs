import assert from "node:assert/strict";
import test from "node:test";

import {
  DARK_THEME,
  LIGHT_THEME,
  CATPPUCCIN_THEME,
  GITHUB_LIGHT_THEME,
  getShellTint,
  isTerminalThemeDark,
  getTerminalTheme,
} from "../src/styles/terminalTheme.ts";

// NOTE: isDarkTheme("system") reads window.matchMedia, which does not exist in
// the node test runner. These tests only exercise the explicit dark/light and
// named-theme paths, which never touch `window`.

test("isTerminalThemeDark follows the app theme for the default terminal theme", () => {
  assert.equal(isTerminalThemeDark("default", "dark"), true);
  assert.equal(isTerminalThemeDark("default", "light"), false);
});

test("isTerminalThemeDark maps named themes regardless of app theme", () => {
  assert.equal(isTerminalThemeDark("catppuccin", "light"), true);
  assert.equal(isTerminalThemeDark("tokyo-night", "light"), true);
  assert.equal(isTerminalThemeDark("github-light", "dark"), false);
  assert.equal(isTerminalThemeDark("rose-pine-dawn", "dark"), false);
});

test("getTerminalTheme returns the matching base palette for explicit app themes", () => {
  assert.deepEqual(getTerminalTheme("dark", "default"), DARK_THEME);
  assert.deepEqual(getTerminalTheme("light", "default"), LIGHT_THEME);
});

test("getTerminalTheme returns the named palette ignoring the app theme", () => {
  assert.deepEqual(getTerminalTheme("light", "catppuccin"), CATPPUCCIN_THEME);
  assert.deepEqual(getTerminalTheme("dark", "github-light"), GITHUB_LIGHT_THEME);
});

test("terminal theme lookup ignores inherited object properties", () => {
  assert.equal(isTerminalThemeDark("constructor", "light"), false);
  assert.deepEqual(getTerminalTheme("light", "constructor"), LIGHT_THEME);
  assert.equal(getShellTint("constructor"), undefined);
  assert.ok(getShellTint("catppuccin"));
});

test("getTerminalTheme blends accent into selectionBackground with 66 alpha on dark themes", () => {
  const theme = getTerminalTheme("dark", "default", "#abcdef");
  assert.equal(theme.selectionBackground, "#abcdef66");
  // The rest of the palette is preserved.
  assert.equal(theme.background, DARK_THEME.background);
  assert.equal(theme.foreground, DARK_THEME.foreground);
});

test("getTerminalTheme blends accent with 44 alpha on light themes", () => {
  const theme = getTerminalTheme("light", "default", "#abcdef");
  assert.equal(theme.selectionBackground, "#abcdef44");
  assert.equal(theme.background, LIGHT_THEME.background);
});

test("getTerminalTheme uses 66 alpha for a named dark theme even when app theme is light", () => {
  const theme = getTerminalTheme("light", "catppuccin", "#112233");
  assert.equal(theme.selectionBackground, "#11223366");
});

test("getTerminalTheme uses 44 alpha for a named light theme even when app theme is dark", () => {
  const theme = getTerminalTheme("dark", "github-light", "#112233");
  assert.equal(theme.selectionBackground, "#11223344");
});

test("getTerminalTheme without an accent leaves the base selectionBackground intact", () => {
  const theme = getTerminalTheme("dark", "default");
  assert.equal(theme.selectionBackground, DARK_THEME.selectionBackground);
});
