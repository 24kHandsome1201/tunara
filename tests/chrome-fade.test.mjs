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

test("native context-menu guard does not consume mouse down or up", () => {
  const guard = read("src/app/useNativeContextMenuGuard.ts");
  assert.match(guard, /addEventListener\("contextmenu", suppressContextMenu, \{ capture: true \}\)/);
  assert.match(guard, /event\.preventDefault\(\)/);
  assert.doesNotMatch(guard, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(guard, /addEventListener\("mouse(?:down|up)"/);
});
