import type { Terminal } from "@xterm/xterm";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { copyText, readClipboardText } from "@/ui/lib/clipboard";
import { pasteWithCapturedBracketedMode, requestProtectedTerminalPaste } from "./terminal-paste-protection";
import { bindingAwareAsyncAction, issueFocusReturnToken, recordTerminalFocusIntent, type BindingAwareAsyncAction } from "./binding-aware-async-action";
import { findKeybindingConflict, matchesKeybinding, TERMINAL_KEYBINDING_ACTIONS, type TerminalKeybindingAction } from "@/modules/config/keybindings";
import { isMac } from "@/ui/lib/platform";
import type { TerminalCommandBlock } from "./terminal-blocks";
import { stringOffsetToCellColumn, type TerminalSearchSource } from "./cross-session-search";

interface TerminalActions {
  terminal: Terminal;
  openSearch: () => void;
  revealAttention?: () => void;
  getBlocks?: () => readonly TerminalCommandBlock[];
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

/**
 * Read-only views over every mounted terminal's in-memory normal buffer
 * (scrollback lives there even while a TUI owns the alternate screen).
 */
export function listTerminalSearchSources(): TerminalSearchSource[] {
  return [...actions.entries()].map(([sessionId, registration]) => {
    const buffer = registration.terminal.buffer.normal;
    return {
      sessionId,
      lineCount: buffer.length,
      readLine: (row: number) => buffer.getLine(row)?.translateToString(true),
      blocks: registration.getBlocks?.() ?? [],
    };
  });
}

/** Explicit navigation only: activates, scrolls and selects; never writes to the PTY. */
export function revealTerminalSearchMatch(sessionId: string, row: number, start: number, end: number): boolean {
  const registration = actions.get(sessionId);
  if (!registration) return false;
  useSessionsStore.getState().setActive(sessionId);
  useUIStore.getState().showTerminal();
  const reveal = () => {
    const current = actions.get(sessionId);
    if (!current) return;
    const { terminal } = current;
    const line = terminal.buffer.normal.getLine(row);
    if (!line) return;
    const cell = terminal.buffer.normal.getNullCell();
    const getCell = (column: number) => {
      const found = line.getCell(column, cell);
      return found ? { chars: found.getChars(), width: found.getWidth() } : null;
    };
    const startColumn = stringOffsetToCellColumn(terminal.cols, getCell, start);
    const endColumn = Math.max(startColumn + 1, stringOffsetToCellColumn(terminal.cols, getCell, end));
    terminal.scrollToLine(Math.max(0, row - Math.floor(terminal.rows / 2)));
    terminal.select(startColumn, row, endColumn - startColumn);
    focusActiveTerminal(sessionId);
  };
  // The target pane may only become visible after the activation re-render.
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  return true;
}

/** Explicit navigation only: never executes or pastes terminal input. */
export function revealSessionAttention(sessionId: string): void {
  if (useSessionsStore.getState().activeSessionId !== sessionId) return;
  const registration = actions.get(sessionId);
  registration?.revealAttention?.();
  focusActiveTerminal(sessionId);
}

export function focusActiveTerminal(sessionId: string): void {
  if (useSessionsStore.getState().activeSessionId !== sessionId) return;
  recordTerminalFocusIntent(sessionId);
  useUIStore.getState().setFocusedPaneId(sessionId);
  const phase = useSessionsStore.getState().sessions.find((s) => s.id === sessionId)?.connection?.phase;
  if (phase === "disconnected" || phase === "failed" || phase === "needsUserAction") {
    const pane = Array.from(document.querySelectorAll<HTMLElement>("[data-terminal-session-id]")).find((el) => el.dataset.terminalSessionId === sessionId);
    const buttons = pane?.querySelectorAll<HTMLButtonElement>('[role="alert"] button');
    const recovery = buttons?.[buttons.length - 1];
    if (recovery && !recovery.disabled) { recovery.focus(); return; }
  }
  actions.get(sessionId)?.terminal.focus();
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
  event.preventDefault();
  return false;
}

export function isNativeTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  macOS = isMac,
): boolean {
  if (event.key.toLowerCase() !== "v" || event.altKey) return false;
  return macOS
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** Returns false when a terminal-scoped action consumed this xterm key event. */
export function handleTerminalInteractionKeyEvent(
  sessionId: string,
  terminal: Terminal,
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown" || actions.get(sessionId)?.terminal !== terminal) return true;
  if (isNativeTerminalPasteShortcut(event)) {
    // Stop xterm from translating the keydown into PTY input, but deliberately
    // do not preventDefault: Wry must create the trusted native `paste` event
    // whose clipboardData is consumed by registerTerminalPasteProtection.
    // This also leaves IME composition and key repeat under native event
    // dispatch instead of initiating parallel clipboard IPC reads here.
    return false;
  }
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
