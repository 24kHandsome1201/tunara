import { getCurrentWindow } from "@tauri-apps/api/window";

let lastBadge: number | null = null;

export async function setDockBadge(count: number) {
  if (lastBadge === count) return;
  lastBadge = count;
  try {
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch {
    // setBadgeCount is a no-op on platforms that don't support it; ignore failures
  }
}
