import type { Terminal } from "@xterm/xterm";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { copyText } from "@/ui/lib/clipboard";
import { requestProtectedTerminalPaste } from "./terminal-paste-protection";
import { bindingAwareAsyncAction, issueFocusReturnToken, type BindingAwareAsyncAction } from "./binding-aware-async-action";

interface TerminalActions {
  terminal: Terminal;
  openSearch: () => void;
}

const actions = new Map<string, TerminalActions>();

export function registerTerminalActions(sessionId: string, value: TerminalActions): () => void {
  actions.set(sessionId, value);
  return () => {
    if (actions.get(sessionId) === value) actions.delete(sessionId);
  };
}

export function captureTerminalActionTarget(sessionId: string, terminal: Terminal): BindingAwareAsyncAction | null {
  const registration = actions.get(sessionId);
  const token = issueFocusReturnToken(sessionId);
  if (!registration || registration.terminal !== terminal || !token || terminal.options.disableStdin === true) return null;
  const binding = bindingAwareAsyncAction(token);
  return {
    token,
    isCurrent: () => actions.get(sessionId) === registration
      && useSessionsStore.getState().activeSessionId === sessionId
      && terminal.options.disableStdin !== true
      && binding.isCurrent(),
    focus: () => binding.focus(),
  };
}

export async function copyActiveTerminal(sessionId: string): Promise<void> {
  const registration = actions.get(sessionId);
  const selection = registration?.terminal.getSelection();
  if (selection) await copyText(selection);
}

export function searchActiveTerminal(sessionId: string): void {
  actions.get(sessionId)?.openSearch();
}

export async function safePasteActiveTerminal(sessionId: string): Promise<void> {
  const registration = actions.get(sessionId);
  if (!registration) return;
  const action = captureTerminalActionTarget(sessionId, registration.terminal);
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !action?.isCurrent()) return;
    const protectedPaste = requestProtectedTerminalPaste(
      registration.terminal,
      text,
      (message) => tauriConfirmDialog(message, { kind: "warning" }),
      () => action.isCurrent(),
    );
    if (!protectedPaste && action.isCurrent()) registration.terminal.paste(text);
  } catch {
    useUIStore.getState().addToast({
      title: t("term.paste_clipboard_denied"),
      subtitle: "",
      variant: "warning",
    });
  }
}
