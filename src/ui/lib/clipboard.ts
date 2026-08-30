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
 * file explorer) have no session context, so feedback stays
 * the caller's decision.
 *
 * Menu-triggered reads use Tauri's clipboard-manager plugin. Keyboard paste
 * stays on the trusted native paste event and never calls this helper.
 */

import { readText } from "@tauri-apps/plugin-clipboard-manager";

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
  try {
    return await readText();
  } catch (error) {
    // arboard uses the same content-unavailable error for an empty clipboard
    // and an image-only clipboard. Both are valid no-op paste requests, not a
    // permission failure. Do not log the error or clipboard contents.
    if (isClipboardTextUnavailable(error)) return "";
    throw error;
  }
}

function isClipboardTextUnavailable(error: unknown): boolean {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error ?? "");
  return /clipboard contents were not available in the requested format|clipboard is empty/i.test(message);
}
