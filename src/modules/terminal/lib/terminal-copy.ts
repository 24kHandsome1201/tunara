import type { Terminal } from "@xterm/xterm";
import { copyText } from "../../../ui/lib/clipboard.ts";

/**
 * ⌘C copy handler for the terminal.
 *
 * macOS convention: ⌘C copies the active selection. If there's no selection,
 * the key is passed through so the terminal still delivers SIGINT (the ⌘C /
 * Ctrl+C interrupt muscle memory is preserved).
 *
 * Returns `false` when the event was handled (copied) so xterm does not also
 * process the key — matching the boolean contract of the existing
 * `attachCustomKeyEventHandler` chain (search + blocks), where `false` means
 * "xterm should not handle this key".
 *
 * Note: local user-initiated copy is intentionally NOT gated by the
 * `terminalClipboardWrite` setting — that setting governs OSC 52 (a remote
 * program writing the host clipboard), a separate, security-sensitive path.
 */
export function handleCopyKeyEvent(term: Terminal, e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return true;
  const isCmdC = e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c";
  if (!isCmdC) return true;
  const selection = term.getSelection();
  if (!selection) return true; // no selection → let ⌘C / Ctrl+C fall through to SIGINT
  void copyText(selection);
  return false; // handled → don't let xterm process the key
}
