import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("background update checks wait for a usable workspace and stay non-blocking", () => {
  const hook = read("src/app/useUpdateReminder.ts");
  const appServices = read("src/app/useAppServices.ts");
  assert.match(hook, /UPDATE_REMINDER_DELAY_MS = 18_000/);
  assert.match(hook, /if \(!ready \|\| import\.meta\.env\.DEV\) return/);
  assert.match(hook, /check\(\{ timeout: 15_000 \}\)/);
  assert.match(hook, /\.catch\(\(\) => \{/);
  assert.match(appServices, /useUpdateReminder\(ready\)/);
});

test("update reminders route directly to the App settings tab", () => {
  const hook = read("src/app/useUpdateReminder.ts");
  const ui = read("src/state/ui.ts");
  const toast = read("src/ui/Toast.tsx");
  const settings = read("src/ui/overlays/Settings.tsx");
  const appUpdate = read("src/ui/overlays/useAppUpdate.ts");
  assert.match(hook, /kind: "open-settings"/);
  assert.match(hook, /tab: "app"/);
  assert.match(ui, /openSettings: \(tab\?: SettingsTab\)/);
  assert.match(toast, /openSettings\(toast\.action\.tab\)/);
  assert.match(settings, /useAppUpdate\(activeTab\)/);
  assert.match(appUpdate, /activeTab !== "app" \|\| appTabCheckStartedRef\.current/);
  assert.match(appUpdate, /void checkForUpdates\(\)/);
  assert.doesNotMatch(toast, /borderLeft: `3px solid/);
  assert.match(toast, /animationPlayState: paused \? "paused" : "running"/);
  assert.doesNotMatch(toast, /animation: paused \? "none"/);
});

test("installed updates guard drafts and flush both durable stores before relaunch", () => {
  const appUpdate = read("src/ui/overlays/useAppUpdate.ts");
  const lifecycle = read("src/app/app-lifecycle.ts");
  const init = read("src/app/useInit.ts");
  const ui = read("src/state/ui.ts");

  assert.match(appUpdate, /requestSafeAppRelaunch\(relaunch/);
  assert.match(appUpdate, /updateStatus === "restartReady"/);
  assert.doesNotMatch(appUpdate, /await relaunch\(\)/);
  assert.match(lifecycle, /requestActiveDirtyDraftAction/);
  assert.match(lifecycle, /Promise\.all\(\[\s*workspaceFlush\(\),\s*flushUserConfig\(\)/);
  assert.match(lifecycle, /workspaceResult !== "saved" \|\| !configSaved/);
  assert.match(init, /registerWorkspaceFlush\(\(\) => persistNow\(\)\)/);
  assert.match(ui, /export async function flushUserConfig\(\): Promise<boolean>/);
  assert.match(ui, /clearTimeout\(persistTimer\)/);
});
