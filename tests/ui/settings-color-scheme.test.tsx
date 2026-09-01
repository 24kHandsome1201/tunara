import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "@/modules/i18n";
import { useTheme } from "@/app/useTheme";
import { useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";
import { terminalThemePreviewColors } from "@/ui/overlays/settings/controls";
import { DARK_THEME, LIGHT_THEME } from "@/styles/terminalTheme";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@/ui/overlays/useAppUpdate", () => ({
  useAppUpdate: () => ({
    appVersion: "2.0.1",
    updateStatus: "current",
    updateVersion: "",
    updateProgress: null,
    canInstallUpdate: false,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
  }),
}));

function ThemeRuntime() {
  useTheme();
  return null;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  useUIStore.setState({
    configLoaded: false,
    settingsTab: "general",
    theme: "dark",
    language: "en",
  });
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
});

test("System, Light, and Dark are one mutually exclusive synchronized choice", async () => {
  render(
    <>
      <ThemeRuntime />
      <Settings onClose={() => {}} />
    </>,
  );

  const group = screen.getByRole("radiogroup", { name: "Terminal & interface color scheme" });
  const dark = within(group).getByRole("radio", { name: "Dark" });
  const light = within(group).getByRole("radio", { name: "Light" });
  expect(dark.getAttribute("aria-checked")).toBe("true");
  expect(light.getAttribute("aria-checked")).toBe("false");
  expect(within(group).getAllByRole("radio")).toHaveLength(3);

  fireEvent.click(light);
  expect(useUIStore.getState()).toMatchObject({ theme: "light" });
  await waitFor(() => {
    expect(document.documentElement.style.getPropertyValue("--terminal-canvas-bg")).toBe("#fffdfb");
  });
  expect(light.getAttribute("aria-checked")).toBe("true");
  expect(dark.getAttribute("aria-checked")).toBe("false");

  fireEvent.click(within(group).getByRole("radio", { name: "System" }));
  expect(useUIStore.getState()).toMatchObject({ theme: "system" });
});

test("the radio group supports roving keyboard selection and whole-window previews", () => {
  useUIStore.setState({ theme: "system" });
  render(<Settings onClose={() => {}} />);

  const group = screen.getByRole("radiogroup", { name: "Terminal & interface color scheme" });
  const radios = within(group).getAllByRole("radio");
  expect(radios).toHaveLength(3);
  for (const radio of radios) {
    const preview = radio.querySelector('[data-color-scheme-preview="window"]');
    expect(preview).not.toBeNull();
    expect(preview?.querySelector('[data-preview-region="sidebar"]')).not.toBeNull();
    expect(preview?.querySelector('[data-preview-region="terminal"]')).not.toBeNull();
    expect(preview?.querySelector('[data-preview-region="panel"]')).not.toBeNull();
  }

  const system = within(group).getByRole("radio", { name: "System" });
  system.focus();
  fireEvent.keyDown(system, { key: "ArrowRight" });
  const light = within(group).getByRole("radio", { name: "Light" });
  expect(document.activeElement).toBe(light);
  expect(light.getAttribute("aria-checked")).toBe("true");
  expect(useUIStore.getState()).toMatchObject({ theme: "light" });

  fireEvent.keyDown(light, { key: "End" });
  const dark = within(group).getByRole("radio", { name: "Dark" });
  expect(document.activeElement).toBe(dark);
  expect(dark.getAttribute("aria-checked")).toBe("true");
  expect(useUIStore.getState()).toMatchObject({ theme: "dark" });
});

test("segmented settings expose one tab stop and support arrow-key selection", () => {
  render(<Settings onClose={() => {}} />);

  const group = screen.getByRole("radiogroup", { name: "Language" });
  const english = within(group).getByRole("radio", { name: "English" });
  const chinese = within(group).getByRole("radio", { name: "简体中文" });
  expect(english.tabIndex).toBe(0);
  expect(chinese.tabIndex).toBe(-1);

  english.focus();
  fireEvent.keyDown(english, { key: "ArrowLeft" });

  expect(document.activeElement).toBe(chinese);
  expect(chinese.getAttribute("aria-checked")).toBe("true");
  expect(chinese.tabIndex).toBe(0);
  expect(english.tabIndex).toBe(-1);
  expect(useUIStore.getState().language).toBe("zh-CN");
});

test("system media changes affect only the System scheme", async () => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  useUIStore.setState({ theme: "system" });
  render(
    <>
      <ThemeRuntime />
      <Settings onClose={() => {}} />
    </>,
  );

  expect(document.documentElement.classList.contains("dark")).toBe(false);
  await act(async () => {
    media.matches = true;
    for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--terminal-canvas-bg")).toBe("#0f0b09");

  fireEvent.click(screen.getByRole("radio", { name: "Light" }));
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--terminal-canvas-bg")).toBe("#fffdfb"));
  await act(async () => {
    media.matches = true;
    for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
  });
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--terminal-canvas-bg")).toBe("#fffdfb");
});

test("default scheme previews mirror the token-derived chrome and palette", () => {
  expect(terminalThemePreviewColors("light", false)).toMatchObject({
    deepest: "#fffdfb",
    sidebar: "#f2ece9",
    raised: "#e9e2de",
    terminal: LIGHT_THEME.background,
    text: LIGHT_THEME.foreground,
    secondaryText: "#5c5552",
    border: "#d4ceca",
  });
  expect(terminalThemePreviewColors("dark", false)).toMatchObject({
    deepest: "#0f0b09",
    sidebar: "#1c1714",
    raised: "#25211e",
    terminal: DARK_THEME.background,
    text: DARK_THEME.foreground,
    secondaryText: "#9f9a97",
    border: "#342f2c",
  });
});

test("recommended Chinese title and description remain readable as a single section", () => {
  setLanguage("zh-CN");
  render(<Settings onClose={() => {}} />);

  const group = screen.getByRole("radiogroup", { name: "界面与终端配色" });
  expect(screen.getByText("浅色、深色和跟随系统使用 Tunara 默认配色。")).toBeTruthy();
  expect(within(group).getByRole("radio", { name: "跟随系统" })).toBeTruthy();
  expect(within(group).getByRole("radio", { name: "浅色" })).toBeTruthy();
  expect(within(group).getByRole("radio", { name: "深色" })).toBeTruthy();
  expect(group.style.gridTemplateColumns).toContain("auto-fit");
});
