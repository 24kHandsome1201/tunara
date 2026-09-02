import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  analyzeTerminalKeybindingRisk,
  analyzeTerminalScopedKeybindingRisk,
  captureKeybinding,
  defaultKeybindingsForPlatform,
  findKeybindingConflict,
  isFixedTerminalMenuEvent,
  isFixedTerminalMenuKeybinding,
  matchesKeybinding,
  sanitizeKeybindings,
} from "@/modules/config/keybindings";
import { useKeybindings } from "@/app/useKeybindings";
import { useUIStore } from "@/state/ui";
import { isMac } from "@/ui/lib/platform";

describe("flow 2 keybindings", () => {
  it("uses mac conventions and terminal-safe Windows/Linux alternatives", () => {
    const mac = defaultKeybindingsForPlatform("macos");
    expect([mac.terminalMenu, mac.copySelection, mac.safePaste]).toEqual(["", "Mod+C", "Mod+V"]);
    expect([mac.newTerminalAlt, mac.closeSession, mac.splitHorizontal, mac.commandPalette])
      .toEqual(["Mod+N", "Mod+W", "Mod+D", "Mod+K"]);
    expect(mac.focusLatestAttention).toBe("Mod+Enter");
    expect(isFixedTerminalMenuEvent({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: true, altKey: false })).toBe(false);
    expect(matchesKeybinding(
      { key: "Enter", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent,
      "Mod+Enter",
      true,
    )).toBe(true);
    expect(matchesKeybinding(
      { key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent,
      "Mod+Enter",
      true,
    )).toBe(false);
    expect(new Set(Object.values(mac)).size).toBe(Object.values(mac).length);
    for (const platform of ["windows", "linux"] as const) {
      const defaults = defaultKeybindingsForPlatform(platform);
      expect([defaults.terminalMenu, defaults.copySelection, defaults.safePaste])
        .toEqual(["", "Ctrl+Shift+C", "Ctrl+Shift+V"]);
      expect([defaults.newTerminalAlt, defaults.closeSession, defaults.splitHorizontal, defaults.commandPalette])
        .toEqual(["Ctrl+Shift+N", "Ctrl+Shift+W", "Alt+Shift+D", "Ctrl+Shift+K"]);
      expect(new Set(Object.values(defaults)).size).toBe(Object.values(defaults).length);
    }
  });

  it("captures canonical combinations, blocks duplicates, and identifies terminal risk", () => {
    expect(captureKeybinding({ key: "k", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe("Ctrl+Shift+K");
    const defaults = defaultKeybindingsForPlatform("linux");
    expect(findKeybindingConflict(defaults, "newTerminal", defaults.closeSession, "linux")).toBe("closeSession");
    expect(findKeybindingConflict({ ...defaults, closeSession: "Mod+W" }, "newTerminal", "Ctrl+W", "linux")).toBe("closeSession");
    expect(analyzeTerminalKeybindingRisk("Ctrl+C", "linux")).toEqual({ risky: true, reason: "bare-control" });
    expect(analyzeTerminalKeybindingRisk("Mod+D", "linux")).toEqual({ risky: true, reason: "bare-control" });
    expect(analyzeTerminalKeybindingRisk("Mod+D", "macos")).toEqual({ risky: false });
    expect(analyzeTerminalKeybindingRisk("Ctrl+Shift+C", "linux")).toEqual({ risky: false });
    expect(analyzeTerminalScopedKeybindingRisk("X", "linux")).toEqual({ risky: true, reason: "shell-tui" });
    expect(analyzeTerminalScopedKeybindingRisk("Alt+X", "linux")).toEqual({ risky: true, reason: "shell-tui" });
    expect(analyzeTerminalScopedKeybindingRisk("Ctrl+Shift+X", "linux")).toEqual({ risky: false });
    expect(analyzeTerminalScopedKeybindingRisk("Ctrl+Shift+X", "macos")).toEqual({ risky: true, reason: "shell-tui" });
    expect(analyzeTerminalScopedKeybindingRisk("Mod+X", "macos")).toEqual({ risky: false });
    expect(findKeybindingConflict({ ...defaults, safePaste: "Ctrl+Shift+X" }, "copySelection", "Ctrl+Shift+X", "linux")).toBe("safePaste");
    expect(sanitizeKeybindings({ terminal_menu: "", copy_selection: "Ctrl+Shift+X", safe_paste: 42 }))
      .toMatchObject({ terminalMenu: "", copySelection: "Ctrl+Shift+X", safePaste: "Ctrl+Shift+V" });
    expect(isFixedTerminalMenuKeybinding("Shift+F10", "linux")).toBe(true);
    expect(isFixedTerminalMenuKeybinding("Ctrl+Shift+F10", "linux")).toBe(false);
    expect(isFixedTerminalMenuEvent({ key: "F10", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isFixedTerminalMenuEvent({ key: "F10", shiftKey: true, ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });

  it("dispatches app bindings in capture phase before terminal descendants", () => {
    function Harness() {
      useKeybindings();
      return <div className="xterm"><textarea aria-label="terminal-input" /></div>;
    }
    useUIStore.setState({
      overlay: null,
      keybindings: { ...defaultKeybindingsForPlatform("linux"), commandPalette: "Ctrl+Shift+K" },
    });
    const addEventListener = vi.spyOn(window, "addEventListener");
    render(<Harness />);
    const registrations = addEventListener.mock.calls.filter(([type]) => type === "keydown");
    expect(registrations).toHaveLength(1);
    const registration = registrations[0];
    expect(registration?.[2]).toEqual({ capture: true });
    const event = {
      key: "k",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    expect(matchesKeybinding(event, "Ctrl+Shift+K", isMac)).toBe(true);
    (registration?.[1] as EventListener)(event);
    expect(useUIStore.getState().overlay).toBe("command-palette");

    const terminalAction = {
      ...event,
      key: "v",
      target: document.querySelector("textarea"),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    (registration?.[1] as EventListener)(terminalAction);
    expect(terminalAction.preventDefault).not.toHaveBeenCalled();

    useUIStore.setState({
      overlay: null,
      keybindings: { ...defaultKeybindingsForPlatform("linux"), commandPalette: "Shift+F10" },
    });
    const fixedRecovery = {
      ...event,
      key: "F10",
      ctrlKey: false,
      shiftKey: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    (registration?.[1] as EventListener)(fixedRecovery);
    expect(fixedRecovery.preventDefault).not.toHaveBeenCalled();
    expect(useUIStore.getState().overlay).toBeNull();

    useUIStore.setState({
      keybindings: { ...defaultKeybindingsForPlatform("linux"), commandPalette: "Ctrl+Shift+F10" },
    });
    const modifiedF10 = { ...fixedRecovery, ctrlKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    (registration?.[1] as EventListener)(modifiedF10);
    expect(modifiedF10.preventDefault).toHaveBeenCalledOnce();
    expect(useUIStore.getState().overlay).toBe("command-palette");
  });
});
