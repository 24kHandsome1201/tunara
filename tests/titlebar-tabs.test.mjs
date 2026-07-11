import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/ui/Titlebar.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

test("titlebar session tabs expose selection and close as separate controls", () => {
  const tabButton = source.slice(source.indexOf("function TabButton"), source.indexOf("function WindowControls"));
  assert.match(tabButton, /role="tab"/);
  assert.match(tabButton, /aria-selected=\{isActive\}/);
  assert.doesNotMatch(tabButton, /tabIndex=\{isActive \? 0 : -1\}/);
  assert.doesNotMatch(tabButton, /<div[\s\S]*?role="button"/);
  assert.match(tabButton, /className="tab-close hover-close"/);
  assert.match(source, /role="tablist"[\s\S]*?aria-label=\{t\("titlebar\.tabs"\)\}/);
});

test("keyboard focus reveals the otherwise quiet close affordance", () => {
  assert.match(styles, /\.tab-close:focus-visible\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/);
});
