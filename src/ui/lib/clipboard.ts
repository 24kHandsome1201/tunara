/**
 * Single front door for writing to the system clipboard.
 *
 * Every UI "copy" affordance (copy path, copy command, copy hunk, quick-select)
 * used to inline `navigator.clipboard.writeText(...).catch(() => {})` with four
 * different error-handling styles. They all route through here now so the
 * Clipboard API guard and error swallowing live in one place.
 *
 * Returns whether the write succeeded so callers that show a toast / checkmark
 * can branch on it. Callers that just want fire-and-forget can ignore the
 * result — failures never throw. Toast/feedback is intentionally NOT done here:
 * the toast store is keyed by `sessionId`, and most copy points (sidebar,
 * file explorer, session overview) have no session context, so feedback stays
 * the caller's decision.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
