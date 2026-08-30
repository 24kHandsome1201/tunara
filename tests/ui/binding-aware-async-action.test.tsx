import { describe, expect, it, vi } from "vitest";
import {
  advanceTerminalFocusEpoch,
  allocateTerminalInstanceEpoch,
  createDeferredTerminalFocus,
  issueFocusReturnToken,
  isFocusReturnTokenCurrent,
  recordTerminalFocusIntent,
  registerTerminalBinding,
  runBindingAwareContinuation,
} from "@/modules/terminal/lib/binding-aware-async-action";

describe("FocusReturnToken", () => {
  it("uses six-field identity and rejects stale focus intent", () => {
    const focus = vi.fn();
    const dispose = registerTerminalBinding({ logicalSessionId: "s", paneId: "p", physicalPtyId: 7, transportGeneration: "g", terminalInstanceEpoch: allocateTerminalInstanceEpoch() }, focus);
    recordTerminalFocusIntent("p");
    const token = issueFocusReturnToken("p")!;
    expect(Object.keys(token).sort()).toEqual(["focusEpoch", "logicalSessionId", "paneId", "physicalPtyId", "terminalInstanceEpoch", "transportGeneration"].sort());
    expect(isFocusReturnTokenCurrent(token)).toBe(true);
    advanceTerminalFocusEpoch();
    expect(runBindingAwareContinuation(token, focus)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    dispose();
  });

  it("rejects a token after logical pane or transport identity changes", () => {
    const disposeA = registerTerminalBinding({ logicalSessionId: "a", paneId: "a", physicalPtyId: 1, transportGeneration: "one", terminalInstanceEpoch: allocateTerminalInstanceEpoch() }, vi.fn());
    recordTerminalFocusIntent("a");
    const token = issueFocusReturnToken("a")!;
    recordTerminalFocusIntent("b");
    expect(isFocusReturnTokenCurrent(token)).toBe(false);
    disposeA();
  });
});

describe("createDeferredTerminalFocus", () => {
  it("focuses once when readiness arrives before the binding", () => {
    const identity = { logicalSessionId: "ready-first", paneId: "ready-first", physicalPtyId: 1, transportGeneration: "one", terminalInstanceEpoch: allocateTerminalInstanceEpoch() };
    const focus = vi.fn();
    const deferredFocus = createDeferredTerminalFocus();

    expect(deferredFocus.ready()).toBe(false);
    const dispose = registerTerminalBinding(identity, focus);
    recordTerminalFocusIntent(identity.paneId);
    expect(deferredFocus.capture(identity.paneId)).toBe(true);
    expect(deferredFocus.capture(identity.paneId)).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("focuses once when the binding arrives before readiness", () => {
    const identity = { logicalSessionId: "binding-first", paneId: "binding-first", physicalPtyId: 2, transportGeneration: "two", terminalInstanceEpoch: allocateTerminalInstanceEpoch() };
    const focus = vi.fn();
    const deferredFocus = createDeferredTerminalFocus();
    const dispose = registerTerminalBinding(identity, focus);

    recordTerminalFocusIntent(identity.paneId);
    expect(deferredFocus.capture(identity.paneId)).toBe(false);
    expect(deferredFocus.ready()).toBe(true);
    expect(deferredFocus.ready()).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not steal focus after the captured intent becomes stale", () => {
    const identity = { logicalSessionId: "stale", paneId: "stale", physicalPtyId: 3, transportGeneration: "three", terminalInstanceEpoch: allocateTerminalInstanceEpoch() };
    const otherIdentity = { logicalSessionId: "current", paneId: "current", physicalPtyId: 4, transportGeneration: "four", terminalInstanceEpoch: allocateTerminalInstanceEpoch() };
    const focus = vi.fn();
    const deferredFocus = createDeferredTerminalFocus();
    const dispose = registerTerminalBinding(identity, focus);
    const disposeOther = registerTerminalBinding(otherIdentity, vi.fn());

    recordTerminalFocusIntent(identity.paneId);
    expect(deferredFocus.capture(identity.paneId)).toBe(false);
    recordTerminalFocusIntent(otherIdentity.paneId);
    expect(deferredFocus.ready()).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    disposeOther();
    dispose();
  });
});
