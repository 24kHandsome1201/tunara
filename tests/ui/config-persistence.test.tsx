import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { expect, test, vi } from "vitest";
import { t } from "@/modules/i18n";
import { DEFAULT_SETTINGS, loadUserConfig, useUIStore } from "@/state/ui";
import { createTerminalInstance } from "@/modules/terminal/lib/terminal-instance";
import { registerTerminalAtlasRebuilder } from "@/modules/terminal/lib/terminal-atlas-refresh";
import { useTerminalRuntimeSync } from "@/ui/useTerminalRuntimeSync";
import type { ThemeType } from "@/ui/types";

function ScreenReaderRuntimeHarness({ enabled, terminal, theme = "light" }: { enabled: boolean; terminal: Terminal; theme?: ThemeType }) {
  const termRef = useRef<Terminal | null>(terminal);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef(null);
  useTerminalRuntimeSync({
    sessionId: "screen-reader-runtime",
    active: true,
    termReady: true,
    termRef,
    fitRef,
    ptyRef,
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    scrollback: 10_000,
    cursorStyle: "bar",
    cursorBlink: true,
    screenReaderMode: enabled,
    theme,
    accent: "#c2683c",
  });
  return null;
}

test("legacy Pure Mode config fields load without becoming settings", async () => {
  expect("showPureModeFilesButton" in DEFAULT_SETTINGS).toBe(false);
  mockIPC((command) => {
    if (command === "load_config") {
      return {
        path: "/tmp/tunara-config.toml",
        config: {
          appearance: { show_pure_mode_files_button: false },
          keybindings: { toggle_presentation_mode: "Mod+Shift+P" },
        },
        error: null,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: false });

  await loadUserConfig();

  expect(useUIStore.getState().configLoaded).toBe(true);
  expect(useUIStore.getState()).not.toHaveProperty("showPureModeFilesButton");
  expect(useUIStore.getState()).not.toHaveProperty("presentationMode");
  expect(useUIStore.getState().keybindings).not.toHaveProperty("togglePresentationMode");
  useUIStore.setState({ configLoaded: false });
});

test("removed named themes fall back to System and a fixed terracotta accent", async () => {
  mockIPC((command) => {
    if (command === "load_config") {
      return {
        path: "/tmp/tunara-config.toml",
        config: { appearance: { theme: "dark", terminal_theme: "catppuccin", accent: "#4f6ef0", scrollback: 2000 } },
        error: null,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: false, theme: "dark" });

  await loadUserConfig();

  expect(useUIStore.getState()).toMatchObject({
    configLoaded: true,
    theme: "system",
    accent: "#c2683c",
    scrollback: 10_000,
  });
  useUIStore.setState({ configLoaded: false, theme: "light" });
});

test("host-modifier bindings hydrate and persist without replacing legacy keybindings", async () => {
  let saved: unknown;
  mockIPC((command, payload) => {
    if (command === "load_config") {
      return {
        path: "/tmp/tunara-config.toml",
        config: {
          appearance: { terminal_host_modifier: "alt" },
          keybindings: { terminal_menu: "", copy_selection: "Ctrl+Shift+X", close_session: "Alt+Q" },
          terminal_interactions: { version: 1, secondary_click: "disabled" },
        },
        error: null,
      };
    }
    if (command === "save_config") {
      saved = (payload as { config: unknown }).config;
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: false, configError: null });

  await loadUserConfig();
  expect(useUIStore.getState()).toMatchObject({
    terminalHostModifier: "alt",
    keybindings: expect.objectContaining({
      terminalMenu: "",
      copySelection: "Ctrl+Shift+X",
      closeSession: "Alt+Q",
    }),
  });

  useUIStore.getState().setKeybinding("safePaste", "");
  await waitFor(() => expect(saved).toMatchObject({
    appearance: { terminal_host_modifier: "alt" },
    terminal_interactions: { version: 1, secondary_click: "smart" },
    keybindings: {
      terminal_menu: "",
      copy_selection: "Ctrl+Shift+X",
      safe_paste: "",
      close_session: "Alt+Q",
    },
  }));
  useUIStore.setState({ configLoaded: false });
});

test("screen reader mode persists and applies to open and new terminals", async () => {
  let saved: unknown;
  mockIPC((command, payload) => {
    if (command === "save_config") {
      saved = (payload as { config: unknown }).config;
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: true, terminalScreenReaderMode: false, configError: null });

  useUIStore.getState().setTerminalScreenReaderMode(true);
  await waitFor(() => expect(saved).toMatchObject({ appearance: { terminal_screen_reader_mode: true } }));

  const existing = createTerminalInstance({
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    scrollback: 10_000,
    theme: "light",
    accent: "#c2683c",
    cursorBlink: true,
    cursorStyle: "bar",
    screenReaderMode: false,
  });
  const view = render(<ScreenReaderRuntimeHarness enabled={false} terminal={existing} />);
  view.rerender(<ScreenReaderRuntimeHarness enabled terminal={existing} />);
  await waitFor(() => expect(existing.options.screenReaderMode).toBe(true));

  const createdAfterToggle = createTerminalInstance({
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    scrollback: 10_000,
    theme: "light",
    accent: "#c2683c",
    cursorBlink: true,
    cursorStyle: "bar",
    screenReaderMode: useUIStore.getState().terminalScreenReaderMode,
  });
  expect(createdAfterToggle.options.screenReaderMode).toBe(true);

  existing.dispose();
  createdAfterToggle.dispose();
  useUIStore.setState({ configLoaded: false, terminalScreenReaderMode: false });
});

test("runtime theme swaps repaint the current terminal frame", async () => {
  const terminal = createTerminalInstance({
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    scrollback: 10_000,
    theme: "light",
    accent: "#c2683c",
    cursorBlink: true,
    cursorStyle: "bar",
    screenReaderMode: false,
  });
  const refresh = vi.spyOn(terminal, "refresh");
  const rebuild = vi.fn();
  const unregisterRebuild = registerTerminalAtlasRebuilder(rebuild);
  const view = render(<ScreenReaderRuntimeHarness enabled={false} terminal={terminal} />);
  rebuild.mockClear();

  view.rerender(<ScreenReaderRuntimeHarness enabled={false} terminal={terminal} theme="dark" />);

  await waitFor(() => expect(terminal.options.theme?.background).toBe("#0f0b09"));
  expect(rebuild).toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  unregisterRebuild();
  terminal.dispose();
});

test("live terminals follow system color-scheme changes without a settings update", async () => {
  let matches = false;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });

  const terminal = createTerminalInstance({
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    scrollback: 10_000,
    theme: "system",
    accent: "#c2683c",
    cursorBlink: true,
    cursorStyle: "bar",
    screenReaderMode: false,
  });
  render(<ScreenReaderRuntimeHarness enabled={false} terminal={terminal} theme="system" />);
  expect(terminal.options.theme?.background).toBe("#fffdfb");

  await act(async () => {
    matches = true;
    for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
  });
  await waitFor(() => expect(terminal.options.theme?.background).toBe("#0f0b09"));

  terminal.dispose();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

test("a save failure still raises an app toast when config loading already reported an error", async () => {
  let saveAttempts = 0;
  mockIPC((command) => {
    if (command === "load_config") {
      return { path: "/tmp/tunara-config.toml", config: {}, error: "config parse warning" };
    }
    if (command === "save_config") {
      saveAttempts += 1;
      throw new Error("disk full");
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: false, configError: null, toasts: [], fontSize: DEFAULT_SETTINGS.fontSize });

  await loadUserConfig();
  expect(useUIStore.getState().configError).toBe("config parse warning");
  useUIStore.getState().setFontSize(DEFAULT_SETTINGS.fontSize + 1);

  await waitFor(() => expect(saveAttempts).toBe(1));
  await waitFor(() => expect(useUIStore.getState().toasts).toEqual([
    expect.objectContaining({
      title: t("settings.config_error"),
      subtitle: "disk full",
      variant: "error",
    }),
  ]));

  useUIStore.setState({ configLoaded: false, configError: null, toasts: [], fontSize: DEFAULT_SETTINGS.fontSize });
});
