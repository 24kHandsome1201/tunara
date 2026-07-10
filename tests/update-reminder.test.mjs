import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("background update checks wait for a usable workspace and stay non-blocking", () => {
  const hook = read("src/app/useUpdateReminder.ts");
  const app = read("src/app/App.tsx");
  assert.match(hook, /UPDATE_REMINDER_DELAY_MS = 18_000/);
  assert.match(hook, /if \(!ready \|\| import\.meta\.env\.DEV\) return/);
  assert.match(hook, /check\(\{ timeout: 15_000 \}\)/);
  assert.match(hook, /\.catch\(\(\) => \{/);
  assert.match(app, /useUpdateReminder\(ready\)/);
});

test("update reminders route directly to the App settings tab", () => {
  const hook = read("src/app/useUpdateReminder.ts");
  const ui = read("src/state/ui.ts");
  const toast = read("src/ui/Toast.tsx");
  const settings = read("src/ui/overlays/Settings.tsx");
  assert.match(hook, /kind: "open-settings"/);
  assert.match(hook, /tab: "app"/);
  assert.match(ui, /openSettings: \(tab\?: SettingsTab\)/);
  assert.match(toast, /openSettings\(toast\.action\.tab\)/);
  assert.match(settings, /activeTab !== "app" \|\| appTabCheckStartedRef\.current/);
  assert.match(settings, /void checkForUpdates\(\)/);
  assert.doesNotMatch(toast, /borderLeft: `3px solid/);
  assert.match(toast, /animationPlayState: paused \? "paused" : "running"/);
  assert.doesNotMatch(toast, /animation: paused \? "none"/);
});
