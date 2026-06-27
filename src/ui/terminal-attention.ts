import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { Terminal } from "@xterm/xterm";
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

/**
 * Returns a handler for `pty.write` rejections. "ssh input queue full" is a
 * real backpressure signal (slow link, large paste) — keystrokes were dropped.
 * Surface it inline (throttled) so the user knows to re-paste instead of
 * silently losing input. Other errors ("no session", "ssh session closed") are
 * benign races with teardown and stay quiet.
 */
export function createInputQueueFullWarner(term: Terminal) {
  let lastWarn = 0;
  return (err: unknown) => {
    const msg = String(err ?? "");
    if (!msg.includes("input queue full")) return;
    const now = Date.now();
    if (now - lastWarn <= 2000) return;
    lastWarn = now;
    term.write(
      "\r\n\x1b[2m[tunara: remote input queue full, some input dropped — try pasting in smaller chunks]\x1b[0m\r\n",
    );
  };
}

/**
 * Run a cleanup/dispose function, logging any error instead of throwing. Used
 * in React effect cleanups so one failing disposable doesn't skip the rest
 * (term.dispose / pty.close would otherwise be leaked by an earlier throw).
 */
export function safeDispose(label: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`TerminalView cleanup (${label}) failed:`, e);
  }
}
