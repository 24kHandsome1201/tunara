import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isSessionMascotId, SESSION_MASCOT_IDS } from "../src/modules/session/session-mascot.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("session mascot ids are stable, unique, and validated", () => {
  assert.equal(new Set(SESSION_MASCOT_IDS).size, 8);
  for (const id of SESSION_MASCOT_IDS) assert.equal(isSessionMascotId(id), true);
  assert.equal(isSessionMascotId("dragon"), false);
  assert.equal(isSessionMascotId(null), false);
});

test("every session mascot ships a local SVG and the source license", () => {
  for (const id of SESSION_MASCOT_IDS) {
    const svg = readFileSync(resolve(root, `src/assets/mascots/${id}.svg`), "utf8");
    assert.match(svg, /^<svg[^>]+viewBox="0 0 32 32"/);
  }
  const license = readFileSync(resolve(root, "src/assets/mascots/LICENSE.md"), "utf8");
  assert.match(license, /microsoft\/fluentui-emoji/);
  assert.match(license, /MIT License/);
});

test("session mascots render in the overview picker, sidebar, and titlebar", () => {
  const overview = readFileSync(resolve(root, "src/ui/SessionOverviewPanel.tsx"), "utf8");
  const card = readFileSync(resolve(root, "src/ui/SessionCard.tsx"), "utf8");
  const titlebar = readFileSync(resolve(root, "src/ui/Titlebar.tsx"), "utf8");
  assert.match(overview, /<SessionMascotPicker session=\{session\}/);
  assert.match(card, /<SessionMascotIcon id=\{session\.mascot\}/);
  assert.match(titlebar, /mascot=\{s\.mascot\}/);
});
