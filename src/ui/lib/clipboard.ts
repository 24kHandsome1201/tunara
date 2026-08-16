/**
 * Single front door for the system clipboard.
 *
 * Writes used to be inlined as `navigator.clipboard.writeText(...)` with four
 * different error-handling styles. They all route through `copyText` so the
 * Clipboard API guard and error swallowing live in one place.
 *
 * Returns whether the write succeeded so callers that show a toast / checkmark
 * can branch on it. Callers that just want fire-and-forget can ignore the
 * result — failures never throw. Toast/feedback is intentionally NOT done here:
 * the toast store is keyed by `sessionId`, and most copy points (sidebar,
 * file explorer, session overview) have no session context, so feedback stays
 * the caller's decision.
 *
 * Reads are a different contract. Safe Paste used to call
 * `navigator.clipboard.readText()`, which makes WKWebView and WebKitGTK show a
 * second native "Paste" button after the user already clicked Paste. In the
 * Tauri webview, `readClipboardText` uses the native `clipboard_read_text`
 * command so that permission sheet never appears. Writes stay on the web
 * clipboard API because they already run under a user gesture and do not
 * trigger that UI.
 */

import { invoke } from "@tauri-apps/api/core";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) {
    try {
      return await invoke<string>("clipboard_read_text");
    } catch (error) {
      // Linux desktops may not ship wl-paste/xclip/xsel. Only then fall back
      // to the Web clipboard API; a loaded native helper that fails must not,
      // because WKWebView readText() is what shows the extra Paste button.
      if (!isClipboardHelperUnavailable(error)) throw error;
    }
  }
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    throw new Error("clipboard unavailable");
  }
  return navigator.clipboard.readText();
}

function isClipboardHelperUnavailable(error: unknown): boolean {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error ?? "");
  return /clipboard helpers unavailable/i.test(message);
}
