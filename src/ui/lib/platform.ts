import { platform } from "@tauri-apps/plugin-os";

/**
 * Single source of truth for "are we on macOS".
 *
 * Detection was duplicated across Titlebar, Settings, useKeybindings,
 * useInit, formatShortcut and useTerminalBlocks — some via the Tauri
 * `platform()` API, some via `navigator.platform`. They are unified here:
 * prefer the Tauri API (accurate inside the webview), fall back to
 * `navigator.platform` when the plugin is unavailable (e.g. plain-browser
 * test/dev contexts). Evaluated once at module load; the OS never changes
 * at runtime.
 */
function detectIsMac(): boolean {
  try {
    return platform() === "macos";
  } catch {
    return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
  }
}

export const isMac = detectIsMac();
