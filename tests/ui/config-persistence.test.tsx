import { mockIPC } from "@tauri-apps/api/mocks";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { t } from "@/modules/i18n";
import { DEFAULT_SETTINGS, loadUserConfig, useUIStore } from "@/state/ui";

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

  expect(useUIStore.getState()).toMatchObject({ configLoaded: true, showPureModeFilesButton: false });
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
