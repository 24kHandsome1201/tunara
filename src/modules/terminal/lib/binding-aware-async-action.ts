import { announceTerminalContext } from "./terminal-context-announcement";

export interface TerminalFocusReturnToken {
  logicalSessionId: string;
  paneId: string;
  physicalPtyId: number;
  transportGeneration: string;
  terminalInstanceEpoch: number;
  focusEpoch: number;
}

interface Binding { token: TerminalFocusReturnToken; focus: () => void }
const bindings = new Map<string, Binding>();
let nextTerminalEpoch = 0;
let focusEpoch = 0;
let logicalActivePaneId: string | null = null;

export function advanceTerminalFocusEpoch(): number { return ++focusEpoch; }
export function allocateTerminalInstanceEpoch(): number { return ++nextTerminalEpoch; }
export function setLogicalActiveTerminalPane(paneId: string): void {
  if (logicalActivePaneId === paneId) return;
  logicalActivePaneId = paneId;
  advanceTerminalFocusEpoch();
}
export function recordTerminalFocusIntent(paneId: string): void {
  logicalActivePaneId = paneId;
  advanceTerminalFocusEpoch();
}
export function registerTerminalBinding(identity: Omit<TerminalFocusReturnToken, "focusEpoch">, focus: () => void): () => void {
  const binding = { token: { ...identity, focusEpoch }, focus };
  bindings.set(identity.paneId, binding);
  return () => { if (bindings.get(identity.paneId) === binding) bindings.delete(identity.paneId); };
}
export function issueFocusReturnToken(paneId: string): TerminalFocusReturnToken | null {
  const binding = bindings.get(paneId);
  return binding ? { ...binding.token, focusEpoch } : null;
}
export function isFocusReturnTokenCurrent(token: TerminalFocusReturnToken): boolean {
  const current = bindings.get(token.paneId);
  return logicalActivePaneId === token.paneId
    && !!current && current.token.logicalSessionId === token.logicalSessionId
    && current.token.physicalPtyId === token.physicalPtyId
    && current.token.transportGeneration === token.transportGeneration
    && current.token.terminalInstanceEpoch === token.terminalInstanceEpoch
    && token.focusEpoch === focusEpoch;
}
export function returnTerminalFocus(token: TerminalFocusReturnToken): boolean {
  if (!isFocusReturnTokenCurrent(token)) return false;
  bindings.get(token.paneId)?.focus();
  return true;
}
export interface BindingAwareAsyncAction { token: TerminalFocusReturnToken; isCurrent(): boolean; focus(): boolean }
export function bindingAwareAsyncAction(token: TerminalFocusReturnToken): BindingAwareAsyncAction {
  return { token, isCurrent: () => isFocusReturnTokenCurrent(token), focus: () => returnTerminalFocus(token) };
}
export function runBindingAwareContinuation(token: TerminalFocusReturnToken, continuation: () => void): boolean {
  if (!isFocusReturnTokenCurrent(token)) {
    announceTerminalContext({ reason: "stale-async", logicalSessionId: token.logicalSessionId });
    return false;
  }
  continuation();
  return true;
}

/** Focus once both an active terminal binding and backend readiness exist.
 * The captured return token prevents a late ready event from stealing focus. */
export function createDeferredTerminalFocus(): {
  capture: (paneId: string) => boolean;
  ready: () => boolean;
} {
  let ready = false;
  let attempted = false;
  let token: TerminalFocusReturnToken | null = null;
  const tryFocus = () => {
    if (attempted || !ready || !token) return false;
    attempted = true;
    const captured = token;
    token = null;
    return returnTerminalFocus(captured);
  };
  return {
    capture: (paneId) => {
      if (attempted) return false;
      token = issueFocusReturnToken(paneId);
      return tryFocus();
    },
    ready: () => {
      ready = true;
      return tryFocus();
    },
  };
}

export function resetTerminalBindingsForTests(): void {
  bindings.clear();
  nextTerminalEpoch = 0;
  focusEpoch = 0;
  logicalActivePaneId = null;
}
