import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/ui/Titlebar.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

test("titlebar keeps device caption, new-session menu, and overflow without working-set tabs", () => {
  assert.match(source, /data-titlebar-device/);
  assert.match(source, /titlebarDeviceCaption/);
  assert.match(source, /titlebar\.new_menu/);
  assert.match(source, /common\.more_actions/);
  assert.doesNotMatch(source, /function TabButton/);
  assert.doesNotMatch(source, /titlebarWorkingSet/);
  assert.doesNotMatch(source, /role="tablist"/);
  assert.doesNotMatch(source, /`\$\{session\.remote\.user\}@\$\{session\.remote\.host\}`/);
});

test("keyboard focus still reveals quiet close affordances in the stylesheet", () => {
  assert.match(styles, /\.tab-close:focus-visible\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/);
});
