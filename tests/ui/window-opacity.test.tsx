import { mockIPC } from "@tauri-apps/api/mocks";
import { act, renderHook } from "@testing-library/react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useTheme } from "@/app/useTheme";
import { registerTerminalAtlasRebuilder } from "@/modules/terminal/lib/terminal-atlas-refresh";
import { useUIStore } from "@/state/ui";
import { LIGHT_THEME } from "@/styles/terminalTheme";
import { useTerminalRuntimeSync } from "@/ui/useTerminalRuntimeSync";

vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
});
vi.mock("@/ui/lib/platform", () => ({ isMac: true }));

beforeEach(() => {
  useUIStore.setState({ theme: "light", backgroundOpacity: 1, backgroundBlur: true });
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-window-translucent");
});

test("dragging within the translucent range does not reapply native blur", () => {
  const blur = vi.fn();
  mockIPC((command, args) => {
    if (command === "set_window_background_blur") blur(args);
  });
  renderHook(() => useTheme());
  const root = document.documentElement;
  const setOpacity = (opacity: number) => act(() => useUIStore.getState().setBackgroundOpacity(opacity));

  setOpacity(0.95);
  setOpacity(0.6);
  setOpacity(0.3);
  expect(root.hasAttribute("data-window-translucent")).toBe(true);
  expect(root.style.getPropertyValue("--window-bg-opacity")).toBe("30%");
  expect(blur.mock.calls).toEqual([[{ enabled: false }], [{ enabled: true }]]);

  act(() => useUIStore.getState().setBackgroundBlur(false));
  act(() => useUIStore.getState().setBackgroundBlur(true));
  setOpacity(1);
  expect(root.hasAttribute("data-window-translucent")).toBe(false);
  expect(root.style.getPropertyValue("--window-bg-opacity")).toBe("");
  expect(blur.mock.calls.slice(2)).toEqual([[{ enabled: false }], [{ enabled: true }], [{ enabled: false }]]);
});

test("provides separate terminal RGB and alpha values for WebKit without color-mix", () => {
  mockIPC(() => undefined);
  renderHook(() => useTheme());
  const style = document.documentElement.style;
  act(() => useUIStore.getState().setBackgroundOpacity(0.3));
  expect(style.getPropertyValue("--terminal-canvas-rgb")).toBe("253, 252, 251");
  expect(style.getPropertyValue("--window-bg-alpha")).toBe("0.3");

  act(() => useUIStore.getState().setTheme("dark"));
  expect(style.getPropertyValue("--terminal-canvas-rgb")).toBe("24, 20, 17");
  expect(style.getPropertyValue("--window-bg-alpha")).toBe("0.3");

  act(() => useUIStore.getState().setBackgroundOpacity(1));
  expect(style.getPropertyValue("--window-bg-alpha")).toBe("");
});

test("dragging within the translucent range does not change the glyph palette or rebuild the atlas", () => {
  const options: Terminal["options"] = {};
  const fit = vi.fn();
  const repaint = vi.fn();
  const rebuild = vi.fn();
  const termRef = { current: { options, rows: 24, refresh: repaint } as unknown as Terminal };
  const fitRef = { current: { fit } as unknown as FitAddon };
  const ptyRef = { current: null };
  const unregister = registerTerminalAtlasRebuilder(rebuild);
  try {
    const { rerender } = renderHook(({ backgroundOpacity }) => useTerminalRuntimeSync({
      sessionId: "opacity", active: false, termReady: true, termRef, fitRef, ptyRef,
      fontSize: 14, fontFamily: "monospace", nerdFontFallback: false, scrollback: 1000,
      cursorStyle: "bar", cursorBlink: false, screenReaderMode: false,
      theme: "light", accent: "#c2683c", backgroundOpacity,
    }), { initialProps: { backgroundOpacity: 1 } });
    expect(options.allowTransparency).toBe(false);
    expect(options.theme?.background).toBe(LIGHT_THEME.background);

    rerender({ backgroundOpacity: 0.95 });
    expect(options.allowTransparency).toBe(true);
    expect(options.theme?.background).toBe(LIGHT_THEME.background + "00");
    const translucentPalette = options.theme;
    rebuild.mockClear();
    fit.mockClear();
    repaint.mockClear();
    rerender({ backgroundOpacity: 0.6 });
    rerender({ backgroundOpacity: 0.3 });

    expect(options.theme).toBe(translucentPalette);
    expect(options.theme?.foreground).toBe(LIGHT_THEME.foreground);
    expect(rebuild).not.toHaveBeenCalled();
    expect(repaint).not.toHaveBeenCalled();
    expect(fit).not.toHaveBeenCalled();

    rerender({ backgroundOpacity: 1 });
    expect(options.allowTransparency).toBe(false);
    expect(options.theme?.background).toBe(LIGHT_THEME.background);
  } finally {
    unregister();
  }
});
