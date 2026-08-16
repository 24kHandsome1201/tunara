import { mockIPC } from "@tauri-apps/api/mocks";
import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { expect, test, vi } from "vitest";
import { t } from "@/modules/i18n";
import { DEFAULT_SETTINGS, loadUserConfig, useUIStore } from "@/state/ui";
import { createTerminalInstance } from "@/modules/terminal/lib/terminal-instance";
import { registerTerminalAtlasRebuilder } from "@/modules/terminal/lib/terminal-atlas-refresh";
import { useTerminalRuntimeSync } from "@/ui/useTerminalRuntimeSync";

function ScreenReaderRuntimeHarness({ enabled, terminal, theme = "light" }: { enabled: boolean; terminal: Terminal; theme?: "light" | "dark" }) {
  const termRef = useRef<Terminal | null>(terminal);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef(null);
  useTerminalRuntimeSync({
    sessionId: "screen-reader-runtime",
    active: true,
    termRef,
    fitRef,
    ptyRef,
    fontSize: 14,
    fontFamily: "JetBrains Mono",
    nerdFontFallback: true,
    scrollback: 2000,
    cursorStyle: "bar",
    cursorBlink: true,
    screenReaderMode: enabled,
    theme,
    terminalTheme: "default",
    accent: "#c2683c",
  });
  return null;
}

test("Pure Mode Files button defaults on and restores its persisted value", async () => {
  expect(DEFAULT_SETTINGS.showPureModeFilesButton).toBe(true);
  mockIPC((command) => {
    if (command === "load_config") {
      return {
        path: "/tmp/tunara-config.toml",
        config: { appearance: { show_pure_mode_files_button: false } },
        error: null,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: false, showPureModeFilesButton: true });

  await loadUserConfig();

  expect(useUIStore.getState()).toMatchObject({
    configLoaded: true,
    showPureModeFilesButton: false,
    terminalSecondaryClick: "smart",
    localUsageLoggingEnabled: false,
  });
  useUIStore.setState({ configLoaded: false, showPureModeFilesButton: true });
});

test("changing the Pure Mode Files setting persists the snake-case config field", async () => {
  let saved: unknown;
  mockIPC((command, payload) => {
    if (command === "save_config") {
      saved = (payload as { config: unknown }).config;
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: true, showPureModeFilesButton: true, configError: null });

  useUIStore.getState().setShowPureModeFilesButton(false);

  await waitFor(() => expect(saved).toMatchObject({ appearance: { show_pure_mode_files_button: false } }));
  useUIStore.setState({ configLoaded: false, showPureModeFilesButton: true });
});

test("local usage logging is opt-in and persists only after native enable succeeds", async () => {
  let saved: unknown;
  mockIPC((command, payload) => {
    if (command === "local_usage_log_set_enabled") {
      return {
        enabled: true,
        directory: "/private/tunara/usage",
        fileCount: 1,
        totalBytes: 128,
        retentionDays: 7,
        maxTotalBytes: 20 * 1024 * 1024,
        maxFileBytes: 2 * 1024 * 1024,
      };
    }
    if (command === "save_config") {
      saved = (payload as { config: unknown }).config;
      return undefined;
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: true, localUsageLoggingEnabled: false, configError: null });

  await useUIStore.getState().setLocalUsageLoggingEnabled(true);

  expect(useUIStore.getState().localUsageLoggingEnabled).toBe(true);
  await waitFor(() => expect(saved).toMatchObject({
    local_usage_logging: { version: 1, enabled: true },
  }));
  useUIStore.setState({ configLoaded: false, localUsageLoggingEnabled: false });
});

test("terminal interaction preset and disabled bindings hydrate and persist without replacing legacy keybindings", async () => {
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
    terminalSecondaryClick: "disabled",
    terminalHostModifier: "alt",
    keybindings: expect.objectContaining({
      terminalMenu: "",
      copySelection: "Ctrl+Shift+X",
      closeSession: "Alt+Q",
    }),
  });

  useUIStore.getState().setTerminalSecondaryClick("menu");
  useUIStore.getState().setKeybinding("safePaste", "");
  await waitFor(() => expect(saved).toMatchObject({
    appearance: { terminal_host_modifier: "alt" },
    terminal_interactions: { version: 1, secondary_click: "menu" },
    keybindings: {
      terminal_menu: "",
      copy_selection: "Ctrl+Shift+X",
      safe_paste: "",
      close_session: "Alt+Q",
    },
  }));
  useUIStore.setState({ configLoaded: false, terminalSecondaryClick: "smart" });
});

test("unknown future terminal interaction values fail closed to smart at runtime", async () => {
  mockIPC((command) => {
    if (command === "load_config") {
      return {
        path: "/tmp/tunara-config.toml",
        config: {
          // Even a currently recognized value must not be interpreted under a
          // future schema version whose semantics may have changed.
          terminal_interactions: { version: 99, secondary_click: "menu" },
        },
        error: null,
      };
    }
    throw new Error(`unexpected command: ${command}`);
  });
  useUIStore.setState({ configLoaded: false, terminalSecondaryClick: "menu" });

  await loadUserConfig();

  expect(useUIStore.getState().terminalSecondaryClick).toBe("smart");
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
    scrollback: 2000,
    theme: "light",
    terminalTheme: "default",
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
    scrollback: 2000,
    theme: "light",
    terminalTheme: "default",
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
    scrollback: 2000,
    theme: "light",
    terminalTheme: "default",
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
