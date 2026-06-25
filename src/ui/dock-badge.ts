import { getCurrentWindow } from "@tauri-apps/api/window";
import { createDockBadgeController } from "./lib/dock-badge-state";

const controller = createDockBadgeController();

export async function setDockBadge(count: number) {
  const { changed, value } = controller.set(count);
  if (!changed) return;
  try {
    await getCurrentWindow().setBadgeCount(value);
  } catch {
    // setBadgeCount is a no-op on platforms that don't support it; ignore failures
  }
}
