import { getCurrentWindow } from "@tauri-apps/api/window";

type CurrentWindow = ReturnType<typeof getCurrentWindow>;

export function tryGetCurrentWindow(): CurrentWindow | null {
  try {
    return getCurrentWindow();
  } catch (error) {
    console.warn("[window] current window unavailable", error);
    return null;
  }
}
