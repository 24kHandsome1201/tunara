import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  analyzeTerminalKeybindingRisk,
  captureKeybinding,
  defaultKeybindingsForPlatform,
  findKeybindingConflict,
  matchesKeybinding,
} from "@/modules/config/keybindings";
import { useKeybindings } from "@/app/useKeybindings";
import { useUIStore } from "@/state/ui";
import { isMac } from "@/ui/lib/platform";

describe("flow 2 keybindings", () => {
  it("uses mac conventions and terminal-safe Windows/Linux alternatives", () => {
    const mac = defaultKeybindingsForPlatform("macos");
    expect([mac.newTerminalAlt, mac.closeSession, mac.splitHorizontal, mac.commandPalette])
      .toEqual(["Mod+N", "Mod+W", "Mod+D", "Mod+K"]);
    for (const platform of ["windows", "linux"] as const) {
      const defaults = defaultKeybindingsForPlatform(platform);
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
  });
});
