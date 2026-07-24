import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_KEYBINDINGS, KEYBINDING_CONFIG_KEYS } from "../src/modules/config/keybindings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("presentation mode has a configurable non-Escape shortcut", () => {
  const nativeConfig = read("src-tauri/src/modules/config.rs");

  assert.equal(DEFAULT_KEYBINDINGS.togglePresentationMode, "Mod+Shift+P");
  assert.equal(KEYBINDING_CONFIG_KEYS.togglePresentationMode, "toggle_presentation_mode");
  assert.notEqual(DEFAULT_KEYBINDINGS.togglePresentationMode.toLowerCase(), "escape");
  assert.match(nativeConfig, /\("toggle_presentation_mode", "Mod\+Shift\+P"\)/);
});

test("presentation mode stays runtime-only and preserves terminal mounts", () => {
  const ui = read("src/state/ui.ts");
  const init = read("src/app/useInit.ts");
  const app = read("src/app/App.tsx");
  const main = read("src/ui/MainArea.tsx");
  const snapshotBuilder = init.slice(init.indexOf("function buildSnapshot"), init.indexOf("export function useInit"));

  assert.match(ui, /presentationMode: "workspace"/);
  assert.doesNotMatch(snapshotBuilder, /presentationMode/);
  assert.match(app, /key="terminal-main-area"/);
  assert.match(main, /key=\{`\$\{session\.id\}:\$\{session\.terminalMountNonce \?\? session\.reconnectNonce \?\? 0\}`\}/);
  assert.match(main, /<TerminalPane session=\{s\} isActive=\{!fileSurfaceActive && s\.id === activeSessionId\} \/>/);
  assert.match(main, /const fileSurfaceActive = !pure && activeFileTabId !== null/);
});

test("pure mode keeps window controls discoverable and fullscreen chrome transient", () => {
  const titlebar = read("src/ui/Titlebar.tsx");
  const init = read("src/app/useInit.ts");
  const topEdgeListener = titlebar.slice(
    titlebar.indexOf("const revealAtTopEdge"),
    titlebar.indexOf("window.addEventListener", titlebar.indexOf("const revealAtTopEdge")),
  );

  assert.match(titlebar, /if \(presentationMode === "pure"\)[\s\S]*if \(nativeFullscreen\)/);
  assert.match(titlebar, /data-presentation-action=\{floating \? "exit-fullscreen-pure" : undefined\}/);
  assert.match(titlebar, /window\.addEventListener\("pointermove", revealAtTopEdge, \{ passive: true \}\)/);
  assert.doesNotMatch(topEdgeListener, /preventDefault|stopPropagation/);
  assert.match(titlebar, /data-presentation-chrome="windowed"/);
  assert.match(titlebar, /<div data-tauri-drag-region style=\{\{ flex: 1 \}\} \/>/);
  assert.match(titlebar, /var\(--terminal-canvas-bg/);
  assert.match(init, /ui\.setNativeFullscreen\(fullscreen\)/);
  assert.match(init, /win\.onResized\(check\)/);
  assert.match(init, /win\.onFocusChanged\(check\)/);
  assert.match(init, /if \(pending\) \{\s*queued = true/);
  assert.match(init, /if \(queued\) \{\s*queued = false;\s*check\(\)/);
});

test("pure mode context-menu guard does not consume mouse down or up", () => {
  const guard = read("src/app/usePresentationModeContextMenuGuard.ts");
  const terminalChrome = read("src/ui/TerminalViewChrome.tsx");

  assert.match(guard, /addEventListener\("contextmenu", suppressContextMenu, \{ capture: true \}\)/);
  assert.match(guard, /event\.preventDefault\(\)/);
  assert.match(guard, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(guard, /addEventListener\("mouse(?:down|up)"/);
  assert.match(terminalChrome, /if \(pure\) \{[\s\S]*e\.preventDefault\(\);[\s\S]*e\.stopPropagation\(\);[\s\S]*return;/);
  assert.match(terminalChrome, /!pure && menu &&/);
});

test("pure mode leaves the terminal Ctrl+F key available to the PTY", () => {
  const search = read("src/ui/useTerminalSearch.ts");

  assert.match(search, /presentationMode === "pure"\) return true/);
});
