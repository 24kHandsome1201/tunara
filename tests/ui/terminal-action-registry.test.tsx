import { beforeEach, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { captureTerminalActionTarget, registerTerminalActions, safePasteActiveTerminal } from "@/modules/terminal/lib/terminal-action-registry";
import {
  allocateTerminalInstanceEpoch,
  recordTerminalFocusIntent,
  registerTerminalBinding,
  resetTerminalBindingsForTests,
} from "@/modules/terminal/lib/binding-aware-async-action";
import { useSessionsStore } from "@/state/sessions";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@/ui/lib/clipboard", () => ({ copyText: vi.fn() }));

function fakeTerminal(): Terminal {
  return {
    options: { disableStdin: false },
    getSelection: () => "",
    paste: vi.fn(),
  } as unknown as Terminal;
}

function registerTarget(terminal: Terminal, physicalPtyId = 7, generation = "generation-a") {
  const disposeActions = registerTerminalActions("pane-a", { terminal, openSearch: () => {} });
  const disposeBinding = registerTerminalBinding({
    logicalSessionId: "pane-a",
    paneId: "pane-a",
    physicalPtyId,
    transportGeneration: generation,
    terminalInstanceEpoch: allocateTerminalInstanceEpoch(),
  }, vi.fn());
  recordTerminalFocusIntent("pane-a");
  return () => { disposeActions(); disposeBinding(); };
}

beforeEach(() => {
  resetTerminalBindingsForTests();
  useSessionsStore.setState({ activeSessionId: "pane-a" });
});

test("paste target consumes the six-field binding-aware focus contract", () => {
  const terminal = fakeTerminal();
  const dispose = registerTarget(terminal);
  const action = captureTerminalActionTarget("pane-a", terminal);

  expect(action?.isCurrent()).toBe(true);
  expect(Object.keys(action!.token).sort()).toEqual([
    "focusEpoch", "logicalSessionId", "paneId", "physicalPtyId",
    "terminalInstanceEpoch", "transportGeneration",
  ].sort());

  recordTerminalFocusIntent("pane-b");
  expect(action?.isCurrent()).toBe(false);
  dispose();
});

test("paste target rejects session, binding generation, terminal, and stdin changes", () => {
  const terminal = fakeTerminal();
  const dispose = registerTarget(terminal);

  const switched = captureTerminalActionTarget("pane-a", terminal);
  useSessionsStore.setState({ activeSessionId: "pane-b" });
  expect(switched?.isCurrent()).toBe(false);

  useSessionsStore.setState({ activeSessionId: "pane-a" });
  recordTerminalFocusIntent("pane-a");
  const replaced = captureTerminalActionTarget("pane-a", terminal);
  registerTerminalBinding({
    logicalSessionId: "pane-a",
    paneId: "pane-a",
    physicalPtyId: 7,
    transportGeneration: "generation-b",
    terminalInstanceEpoch: allocateTerminalInstanceEpoch(),
  }, vi.fn());
  expect(replaced?.isCurrent()).toBe(false);

  terminal.options.disableStdin = true;
  expect(captureTerminalActionTarget("pane-a", terminal)).toBeNull();
  expect(captureTerminalActionTarget("pane-a", fakeTerminal())).toBeNull();
  dispose();
});

test("Safe Paste drops a clipboard continuation after a session switch", async () => {
  let resolveClipboard!: (text: string) => void;
  const clipboardText = new Promise<string>((resolve) => { resolveClipboard = resolve; });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn(() => clipboardText) },
  });
  const terminal = fakeTerminal();
  const dispose = registerTarget(terminal);

  const paste = safePasteActiveTerminal("pane-a");
  useSessionsStore.setState({ activeSessionId: "pane-b" });
  recordTerminalFocusIntent("pane-b");
  resolveClipboard("echo should-not-run");
  await paste;

  expect(terminal.paste).not.toHaveBeenCalled();
  dispose();
});
