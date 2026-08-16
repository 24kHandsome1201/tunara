import { beforeEach, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { captureTerminalActionTarget, copyActiveTerminal, handleTerminalInteractionKeyEvent, openTerminalMenu, registerTerminalActions, registerTerminalMenuAction, safePasteActiveTerminal } from "@/modules/terminal/lib/terminal-action-registry";
import {
  allocateTerminalInstanceEpoch,
  recordTerminalFocusIntent,
  registerTerminalBinding,
  resetTerminalBindingsForTests,
} from "@/modules/terminal/lib/binding-aware-async-action";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { defaultKeybindingsForPlatform } from "@/modules/config/keybindings";
import { copyText, readClipboardText } from "@/ui/lib/clipboard";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@/ui/lib/clipboard", () => ({ copyText: vi.fn(), readClipboardText: vi.fn() }));

function fakeTerminal(selection = ""): Terminal {
  return {
    options: { disableStdin: false },
    modes: { bracketedPasteMode: false },
    getSelection: () => selection,
    input: vi.fn(),
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
  useUIStore.setState({
    presentationMode: "workspace",
    keybindings: defaultKeybindingsForPlatform("linux"),
  });
  vi.mocked(copyText).mockReset();
  vi.mocked(readClipboardText).mockReset();
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
  vi.mocked(readClipboardText).mockReturnValue(clipboardText);
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

test("Safe Paste captures bracketed mode before awaiting clipboard access", async () => {
  let resolveClipboard!: (text: string) => void;
  vi.mocked(readClipboardText).mockReturnValue(new Promise<string>((resolve) => { resolveClipboard = resolve; }));
  const terminal = fakeTerminal();
  const modes = terminal.modes as { bracketedPasteMode: boolean };
  modes.bracketedPasteMode = true;
  const dispose = registerTarget(terminal);

  const paste = safePasteActiveTerminal("pane-a");
  modes.bracketedPasteMode = false;
  resolveClipboard("echo safe");
  await paste;

  expect(terminal.paste).not.toHaveBeenCalled();
  expect(terminal.input).toHaveBeenCalledWith("\u001b[200~echo safe\u001b[201~", true);
  dispose();
});

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: "keydown",
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as KeyboardEvent;
}

test("configured Copy consumes only a non-empty selection and otherwise reaches the PTY", () => {
  const selected = fakeTerminal("selected text");
  const disposeSelected = registerTarget(selected);
  const copy = keyEvent("c", { ctrlKey: true, shiftKey: true });

  expect(handleTerminalInteractionKeyEvent("pane-a", selected, copy)).toBe(false);
  expect(copy.preventDefault).toHaveBeenCalledOnce();
  expect(copyActiveTerminal("pane-a")).toBe(true);
  expect(copyText).toHaveBeenCalledTimes(2);
  expect(copyText).toHaveBeenLastCalledWith("selected text");
  disposeSelected();

  recordTerminalFocusIntent("pane-a");
  const empty = fakeTerminal();
  const disposeEmpty = registerTarget(empty, 8, "generation-empty");
  expect(handleTerminalInteractionKeyEvent("pane-a", empty, copy)).toBe(true);
  expect(copyText).toHaveBeenCalledTimes(2);
  disposeEmpty();
});

test("Copy remains available for a read-only or exited active terminal", () => {
  const terminal = fakeTerminal("completed output");
  terminal.options.disableStdin = true;
  const dispose = registerTarget(terminal);

  expect(copyActiveTerminal("pane-a")).toBe(true);
  expect(copyText).toHaveBeenCalledWith("completed output");
  dispose();
});

test("configured Safe Paste cancels native paste and uses the binding-aware registry once", async () => {
  vi.mocked(readClipboardText).mockResolvedValue("echo safe");
  const terminal = fakeTerminal();
  const dispose = registerTarget(terminal);

  const event = keyEvent("v", { ctrlKey: true, shiftKey: true });
  expect(handleTerminalInteractionKeyEvent("pane-a", terminal, event)).toBe(false);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(terminal.paste).toHaveBeenCalledWith("echo safe"));
  expect(terminal.paste).toHaveBeenCalledOnce();
  expect(readClipboardText).toHaveBeenCalledOnce();
  dispose();
});

test("menu binding is scoped to the active workspace terminal and disabled in Pure Mode", () => {
  const terminal = fakeTerminal();
  const disposeTarget = registerTarget(terminal);
  const open = vi.fn();
  const disposeMenu = registerTerminalMenuAction("pane-a", open);
  useUIStore.setState({
    keybindings: { ...defaultKeybindingsForPlatform("linux"), terminalMenu: "Ctrl+Shift+M" },
  });
  const event = keyEvent("m", { ctrlKey: true, shiftKey: true });

  expect(handleTerminalInteractionKeyEvent("pane-a", terminal, event)).toBe(false);
  expect(open).toHaveBeenCalledOnce();
  expect(openTerminalMenu("pane-a")).toBe(true);
  expect(open).toHaveBeenCalledTimes(2);

  useUIStore.setState({ presentationMode: "pure" });
  expect(handleTerminalInteractionKeyEvent("pane-a", terminal, event)).toBe(true);
  expect(openTerminalMenu("pane-a")).toBe(false);
  expect(open).toHaveBeenCalledTimes(2);
  disposeMenu();
  disposeTarget();
});

test("manual terminal binding collisions are consumed without using action order or reaching the PTY", () => {
  const terminal = fakeTerminal("selection");
  const dispose = registerTarget(terminal);
  useUIStore.setState({
    keybindings: {
      ...defaultKeybindingsForPlatform("linux"),
      copySelection: "Ctrl+Shift+X",
      safePaste: "Ctrl+Shift+X",
    },
  });

  const event = keyEvent("x", { ctrlKey: true, shiftKey: true });
  expect(handleTerminalInteractionKeyEvent("pane-a", terminal, event)).toBe(false);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(copyText).not.toHaveBeenCalled();
  dispose();
});
