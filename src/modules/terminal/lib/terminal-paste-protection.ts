import { t } from "../../i18n/core.ts";

export const TERMINAL_LARGE_PASTE_WARNING_LENGTH = 5 * 1024;

export interface TerminalPasteWarning {
  charCount: number;
  lineCount: number;
  large: boolean;
  multiline: boolean;
}

interface PasteTarget {
  element?: HTMLElement | null;
  modes?: { bracketedPasteMode: boolean };
  input?(data: string, wasUserInput?: boolean): void;
  paste(data: string): void;
}

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export function pasteWithCapturedBracketedMode(
  term: PasteTarget,
  text: string,
  bracketedPasteMode: boolean,
): void {
  if (term.element && !term.element.isConnected) return;
  if (!bracketedPasteMode || !term.input) {
    term.paste(text);
    return;
  }
  // Match xterm's Clipboard.paste transformation, but use the mode captured
  // before the native confirmation sheet steals focus. Codex can briefly clear
  // DECSET 2004 while that sheet closes; consulting the live mode at that point
  // converts embedded newlines into Return and submits the prompt.
  const normalized = text.replace(/\r?\n/g, "\r");
  term.input(`${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}`, true);
}

export function analyzeTerminalPaste(text: string): TerminalPasteWarning | null {
  if (!text) return null;
  const lineBreaks = (text.match(/\r\n|\r|\n/g) ?? []).length;
  const multiline = lineBreaks > 0;
  const large = text.length > TERMINAL_LARGE_PASTE_WARNING_LENGTH;
  if (!multiline && !large) return null;
  // A single trailing newline is the Enter that submits the last line, not an
  // extra line — don't count it (so "echo hi\n" reports 1 line, not 2).
  const hasTrailingNewline = /\r\n$|[\r\n]$/.test(text);
  return {
    charCount: text.length,
    lineCount: hasTrailingNewline ? lineBreaks : lineBreaks + 1,
    large,
    multiline,
  };
}

export function terminalPasteWarningMessage(warning: TerminalPasteWarning): string {
  const parts = [];
  if (warning.multiline) parts.push(t("paste.warning.lines", { count: warning.lineCount }));
  if (warning.large) parts.push(t("paste.warning.chars", { count: warning.charCount }));
  const summary = parts.join(", ") || t("paste.warning.summary_default");
  return t("paste.warning.message", { summary });
}

/**
 * Async-capable so the confirmation can come from the Tauri dialog plugin.
 * NEVER use `window.confirm` here: wry's WKWebView implements no JS-dialog UI
 * delegate, so it shows nothing and synchronously returns a falsy value — the
 * old default silently swallowed every multiline/large paste in the app.
 */
export type TerminalPasteConfirmer = (message: string) => boolean | Promise<boolean>;

/**
 * Returns whether this paste was *intercepted* (a warning is being shown), NOT
 * whether it was pasted. `true` means the caller should preventDefault and stop
 * the native paste — the actual paste happens asynchronously via `paste()` once
 * the user confirms. `false` means the text was safe and the caller should let
 * xterm's own paste handler run.
 */
export function confirmProtectedTerminalPaste(
  text: string,
  confirmPaste: TerminalPasteConfirmer,
  paste: (text: string) => void,
): boolean {
  const warning = analyzeTerminalPaste(text);
  if (!warning) return false;
  void Promise.resolve(confirmPaste(terminalPasteWarningMessage(warning)))
    .then((confirmed) => {
      if (confirmed) paste(text);
    })
    .catch(() => {
      /* dialog dismissed/unavailable → treat as cancel */
    });
  return true;
}

export function requestProtectedTerminalPaste(
  term: PasteTarget,
  text: string,
  confirmPaste: TerminalPasteConfirmer,
  isCurrent: () => boolean,
): boolean {
  const bracketedPasteRequired = term.modes?.bracketedPasteMode === true;
  return confirmProtectedTerminalPaste(text, confirmPaste, (value) => {
    if (!isCurrent()) return;
    pasteWithCapturedBracketedMode(term, value, bracketedPasteRequired);
  });
}

export function registerTerminalPasteProtection(
  term: PasteTarget,
  confirmPaste: TerminalPasteConfirmer,
) {
  const element = term.element;
  if (!element) return { dispose() {} };
  let active = true;

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const protectedPaste = requestProtectedTerminalPaste(term, text, confirmPaste, () => active);
    if (!protectedPaste) return;
    event.preventDefault();
    event.stopPropagation();
  };

  element.addEventListener("paste", onPaste, true);
  return {
    dispose() {
      active = false;
      element.removeEventListener("paste", onPaste, true);
    },
  };
}
