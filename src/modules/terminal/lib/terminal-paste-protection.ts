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
  paste(data: string): void;
}

export function analyzeTerminalPaste(text: string): TerminalPasteWarning | null {
  if (!text) return null;
  const lineBreaks = (text.match(/\r\n|\r|\n/g) ?? []).length;
  const multiline = lineBreaks > 0;
  const large = text.length > TERMINAL_LARGE_PASTE_WARNING_LENGTH;
  if (!multiline && !large) return null;
  return {
    charCount: text.length,
    lineCount: lineBreaks + 1,
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

export function confirmProtectedTerminalPaste(
  text: string,
  confirmPaste: (message: string) => boolean,
  paste: (text: string) => void,
): boolean {
  const warning = analyzeTerminalPaste(text);
  if (!warning) return false;
  if (confirmPaste(terminalPasteWarningMessage(warning))) paste(text);
  return true;
}

export function registerTerminalPasteProtection(
  term: PasteTarget,
  confirmPaste: (message: string) => boolean = (message) => window.confirm(message),
) {
  const element = term.element;
  if (!element) return { dispose() {} };

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const protectedPaste = confirmProtectedTerminalPaste(text, confirmPaste, (value) => term.paste(value));
    if (!protectedPaste) return;
    event.preventDefault();
    event.stopPropagation();
  };

  element.addEventListener("paste", onPaste, true);
  return {
    dispose() {
      element.removeEventListener("paste", onPaste, true);
    },
  };
}
