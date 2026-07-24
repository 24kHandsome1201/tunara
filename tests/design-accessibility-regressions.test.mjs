import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("waiting confirmation uses a dedicated readable text token", () => {
  const tokens = read("src/styles/tokens.css");
  const card = read("src/ui/SessionCard.tsx");
  const global = read("src/ui/GlobalAgentBar.tsx");
  assert.match(tokens, /--c-warning-text:\s*oklch\(43%/);
  assert.match(tokens, /--c-warning-bg:/);
  assert.match(card, /var\(--c-warning-text\)/);
  assert.match(global, /var\(--c-warning-text\)/);
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
