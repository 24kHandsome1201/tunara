import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_KEYBINDINGS, KEYBINDING_ACTIONS } from "../src/modules/config/keybindings.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("pure mode keybinding and store fields are gone", () => {
  const nativeConfig = read("src-tauri/src/modules/config.rs");
  const ui = read("src/state/ui.ts");
  const keybindings = read("src/modules/config/keybindings.ts");

  assert.equal("togglePresentationMode" in DEFAULT_KEYBINDINGS, false);
  assert.equal(KEYBINDING_ACTIONS.includes("togglePresentationMode"), false);
  assert.doesNotMatch(keybindings, /togglePresentationMode/);
  assert.match(nativeConfig, /keybindings\.remove\("toggle_presentation_mode"\)/);
  assert.match(nativeConfig, /appearance\.remove\("show_pure_mode_files_button"\)/);
  assert.doesNotMatch(nativeConfig, /pub show_pure_mode_files_button/);
  assert.doesNotMatch(ui, /presentationMode/);
  assert.doesNotMatch(ui, /showPureModeFilesButton/);
  assert.doesNotMatch(ui, /setPresentationMode|togglePresentationMode/);
});

test("chrome fade is a runtime projection that does not persist", () => {
  const init = read("src/app/useInit.ts");
  const snapshotBuilder = init.slice(init.indexOf("function buildSnapshot"), init.indexOf("export function useInit"));
  const persistSnapshot = read("src/state/persist-snapshot.ts");
  const fade = read("src/app/useChromeFade.ts");
  const app = read("src/app/App.tsx");
  const main = read("src/ui/MainArea.tsx");

  assert.doesNotMatch(snapshotBuilder, /chromeFaded|presentationMode/);
  assert.match(persistSnapshot, /toggle-presentation-mode/);
  assert.match(fade, /export function useChromeFade/);
  assert.match(app, /data-chrome-faded=\{chromeFaded \? "true" : undefined\}/);
  assert.match(app, /key="terminal-main-area"/);
  assert.match(main, /key=\{`\$\{session\.id\}:\$\{session\.terminalMountNonce \?\? session\.reconnectNonce \?\? 0\}`\}/);
  assert.match(main, /<TerminalPane session=\{s\} isActive=\{effectiveFocusedPaneId === s\.id\} \/>/);
  assert.match(main, /<ReaderPane session=\{s\} active=\{effectiveFocusedPaneId === readerPaneId\(s\.id\)\} \/>/);
});

test("native context-menu guard does not consume mouse down or up", () => {
  const guard = read("src/app/useNativeContextMenuGuard.ts");
  assert.match(guard, /addEventListener\("contextmenu", suppressContextMenu, \{ capture: true \}\)/);
  assert.match(guard, /event\.preventDefault\(\)/);
  assert.doesNotMatch(guard, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(guard, /addEventListener\("mouse(?:down|up)"/);
});
