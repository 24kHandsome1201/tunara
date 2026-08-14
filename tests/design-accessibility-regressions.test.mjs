import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The settings overlay is split across a shell and per-tab modules; scan them
// together so source assertions keep covering the whole settings surface.
const readSettingsSources = () => [
  "src/ui/overlays/Settings.tsx",
  "src/ui/overlays/settings/AppearanceSettings.tsx",
  "src/ui/overlays/settings/ShortcutsSettings.tsx",
  "src/ui/overlays/settings/CliSettings.tsx",
  "src/ui/overlays/settings/AppSettings.tsx",
  "src/ui/overlays/settings/WorkflowsSettings.tsx",
  "src/ui/overlays/settings/useCliStatus.ts",
  "src/ui/overlays/settings/controls.tsx",
].map(read).join("\n");

test("waiting confirmation uses a dedicated readable text token", () => {
  const tokens = read("src/styles/tokens.css");
  const card = read("src/ui/SessionCard.tsx");
  const global = read("src/ui/GlobalAgentBar.tsx");
  assert.match(tokens, /--c-warning-text:\s*oklch\(43%/);
  assert.match(tokens, /--c-warning-bg:/);
  assert.match(card, /var\(--c-warning-text\)/);
  assert.match(global, /var\(--c-warning-text\)/);
});

test("settings shortcuts and terminal interaction controls define every visual state", () => {
  const settings = readSettingsSources();
  const styles = read("src/styles/globals.css");
  const palettes = read("src/styles/terminalTheme.ts");

  assert.match(settings, /className="settings-terminal-interactions"/);
  assert.match(settings, /className="settings-control"/);
  assert.match(settings, /className="settings-shortcut-input"/);
  assert.match(settings, /className="settings-action-button"/);
  assert.match(settings, /<kbd className="settings-key-hint"/);
  assert.match(styles, /\.settings-action-button:hover:not\(:disabled\)/);
  assert.match(styles, /\.settings-action-button:active:not\(:disabled\)/);
  assert.match(styles, /\.settings-action-button:focus-visible/);
  assert.match(styles, /\.settings-action-button:disabled/);
  assert.match(styles, /\.dark \.settings-control \{ color-scheme: dark; \}/);
  assert.match(styles, /border: 1px solid var\(--c-control-border\)/);
  assert.equal((palettes.match(/"--c-control-border"/g) ?? []).length, 6);
});

test("folder-based terminal creation stays visible in empty and compact shells", () => {
  const app = read("src/app/App.tsx");
  const titlebar = read("src/ui/Titlebar.tsx");
  assert.match(app, /onClick=\{newTerminalInDirectory\}[\s\S]*sidebar\.new_terminal_in_directory/);
  assert.match(titlebar, /onClick=\{onNewTerminalInDirectory\}[\s\S]*titlebar\.new_terminal_in_directory/);
});

test("session and activity rows do not nest action buttons inside button roles", () => {
  const card = read("src/ui/SessionCard.tsx");
  const global = read("src/ui/GlobalAgentBar.tsx");
  assert.match(card, /data-session-card-id=[\s\S]*className="session-card-select"/);
  assert.doesNotMatch(card, /role="button"/);
  assert.match(global, /role="group"[\s\S]*className="gbar-row-select"/);
  assert.doesNotMatch(card, /role="listitem"/);
  assert.doesNotMatch(global, /role="button"/);
});
