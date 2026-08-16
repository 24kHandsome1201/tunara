import type { Terminal } from "@xterm/xterm";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { copyText, readClipboardText } from "@/ui/lib/clipboard";
import { pasteWithCapturedBracketedMode, requestProtectedTerminalPaste } from "./terminal-paste-protection";
import { bindingAwareAsyncAction, issueFocusReturnToken, type BindingAwareAsyncAction } from "./binding-aware-async-action";
import { findKeybindingConflict, matchesKeybinding, TERMINAL_KEYBINDING_ACTIONS, type TerminalKeybindingAction } from "@/modules/config/keybindings";
import { isMac } from "@/ui/lib/platform";

interface TerminalActions {
  terminal: Terminal;
  openSearch: () => void;
}

const actions = new Map<string, TerminalActions>();
const menuActions = new Map<string, () => void>();

export function registerTerminalActions(sessionId: string, value: TerminalActions): () => void {
  actions.set(sessionId, value);
  return () => {
    if (actions.get(sessionId) === value) actions.delete(sessionId);
  };
}

export function registerTerminalMenuAction(sessionId: string, openMenu: () => void): () => void {
  menuActions.set(sessionId, openMenu);
  return () => {
    if (menuActions.get(sessionId) === openMenu) menuActions.delete(sessionId);
  };
}

export function openTerminalMenu(sessionId: string): boolean {
  if (useUIStore.getState().presentationMode === "pure") return false;
  const openMenu = menuActions.get(sessionId);
  if (!openMenu || useSessionsStore.getState().activeSessionId !== sessionId) return false;
  openMenu();
  return true;
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

export function copyActiveTerminal(sessionId: string): boolean {
  const registration = actions.get(sessionId);
  // Copy reads already-rendered host state and never writes to the PTY. Keep it
  // available for an exited/read-only terminal while still requiring the live
  // registry entry to belong to the active session.
  if (!registration || useSessionsStore.getState().activeSessionId !== sessionId) return false;
  const selection = registration.terminal.getSelection();
  if (!selection) return false;
  void copyText(selection);
  return true;
}

export function searchActiveTerminal(sessionId: string): void {
  actions.get(sessionId)?.openSearch();
}

export async function safePasteActiveTerminal(sessionId: string): Promise<void> {
  const registration = actions.get(sessionId);
  if (!registration) return;
  const action = captureTerminalActionTarget(sessionId, registration.terminal);
  if (!action) return;
  // Native clipboard IPC can still move focus, and terminal programs can toggle
  // DECSET 2004 while the read is pending. Capture both target identity and
  // bracketed-paste semantics before the first asynchronous boundary. Do not
  // use navigator.clipboard.readText() here: WKWebView/WebKitGTK then shows a
  // second native Paste button after the user already chose Paste.
  const bracketedPasteRequired = registration.terminal.modes.bracketedPasteMode === true;
  try {
    const text = await readClipboardText();
    if (!text || !action.isCurrent()) return;
    const protectedPaste = requestProtectedTerminalPaste(
      registration.terminal,
      text,
      (message) => tauriConfirmDialog(message, { kind: "warning" }),
      () => action.isCurrent(),
      bracketedPasteRequired,
    );
    if (!protectedPaste && action.isCurrent()) {
      pasteWithCapturedBracketedMode(registration.terminal, text, bracketedPasteRequired);
    }
  } catch {
    useUIStore.getState().addToast({
      title: t("term.paste_clipboard_denied"),
      subtitle: "",
      variant: "warning",
    });
  }
}

type TerminalKeyResolution = TerminalKeybindingAction | "conflict" | null;

function terminalKeyActionForEvent(event: KeyboardEvent): TerminalKeyResolution {
  const { keybindings } = useUIStore.getState();
  for (const action of TERMINAL_KEYBINDING_ACTIONS) {
    const binding = keybindings[action];
    if (!binding || !matchesKeybinding(event, binding, isMac)) continue;
    // Manually edited TOML can bypass Settings conflict checks. In that case,
    // preserve the established app binding (handled in window capture) and do
    // not resolve terminal-terminal collisions by declaration order.
    if (findKeybindingConflict(keybindings, action, binding)) return "conflict";
    return action;
  }
  return null;
}

function consumeTerminalKeyEvent(event: KeyboardEvent): false {
  // Returning false only stops xterm's own key processing; it does not cancel
  // the browser default. Explicitly cancel so a Safe Paste shortcut cannot also
  // emit a native paste event and write the clipboard twice.
  event.preventDefault();
  return false;
}

/** Returns false when a terminal-scoped action consumed this xterm key event. */
export function handleTerminalInteractionKeyEvent(
  sessionId: string,
  terminal: Terminal,
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown" || actions.get(sessionId)?.terminal !== terminal) return true;
  const action = terminalKeyActionForEvent(event);
  if (!action) return true;
  if (action === "conflict") return consumeTerminalKeyEvent(event);
  switch (action) {
    case "copySelection":
      // With no selection the chord must continue to the PTY (notably Cmd+C),
      // preserving interrupt behavior rather than creating a dead shortcut.
      return copyActiveTerminal(sessionId) ? consumeTerminalKeyEvent(event) : true;
    case "safePaste":
      void safePasteActiveTerminal(sessionId);
      return consumeTerminalKeyEvent(event);
    case "terminalMenu":
      return openTerminalMenu(sessionId) ? consumeTerminalKeyEvent(event) : true;
  }
}
