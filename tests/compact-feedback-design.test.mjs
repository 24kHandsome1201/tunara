import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("error feedback remains readable and is not an interactive-role container", () => {
  const toast = read("src/ui/Toast.tsx");
  assert.match(toast, /ERROR_TOAST_DURATION = 12000/);
  assert.match(toast, /role=\{toast\.variant === "error" \? "alert" : "status"\}/);
  assert.doesNotMatch(toast, /role="button"/);
  assert.match(toast, /className="toast-primary-action"/);
  assert.match(toast, /aria-label=\{t\("common\.close"\)\}/);
});

test("settings tabs remain navigable at narrow widths", () => {
  const settings = read("src/ui/overlays/Settings.tsx");
  assert.match(settings, /role="tablist"/);
  assert.match(settings, /overflowX: "auto"/);
  assert.match(settings, /whiteSpace: "nowrap"/);
  assert.match(settings, /aria-selected=\{activeTab === tab\}/);
});

test("mouse and keyboard drawer entry points share compact exclusivity", () => {
  const app = read("src/app/App.tsx");
  const keys = read("src/app/useKeybindings.ts");
  assert.match(app, /auxiliarySurfaceToCloseOnOpen/);
  assert.match(keys, /auxiliarySurfaceToCloseOnOpen/);
});
