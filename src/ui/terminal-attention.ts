import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { TerminalNotification } from "@/modules/terminal/lib/terminal-notification";
import { useUIStore } from "@/state/ui";

export function requestInformationalAttention() {
  if (document.hasFocus() || !useUIStore.getState().bellNotification) return;
  getCurrentWindow()
    .requestUserAttention(UserAttentionType.Informational)
    .catch(() => {});
}

export function emitTerminalNotification(sessionId: string, notification: TerminalNotification) {
  if (!useUIStore.getState().bellNotification) return;
  useUIStore.getState().addToast({
    sessionId,
    title: notification.title,
    subtitle: notification.body ?? "终端通知",
    variant: "success",
  });
  requestInformationalAttention();
}
