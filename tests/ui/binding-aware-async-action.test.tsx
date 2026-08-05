import { describe, expect, it, vi } from "vitest";
import {
  advanceTerminalFocusEpoch,
  allocateTerminalInstanceEpoch,
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
