import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { defaultKeybindingsForPlatform } from "@/modules/config/keybindings";
import { useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@/ui/overlays/useAppUpdate", () => ({
  useAppUpdate: () => ({
    appVersion: "1.17.1",
    updateStatus: "current",
    updateVersion: "",
    updateProgress: null,
    canInstallUpdate: false,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
  }),
}));

test("terminal interaction presets warn before TUI override and keep recovery instructions", () => {
  useUIStore.setState({
    configLoaded: false,
    settingsTab: "appearance",
    terminalSecondaryClick: "smart",
    terminalHostModifier: "shift",
    keybindings: defaultKeybindingsForPlatform("linux"),
  });
  render(<Settings onClose={() => {}} />);

  const secondaryClick = screen.getByLabelText("Open shortcut menu with secondary click");
  fireEvent.change(secondaryClick, { target: { value: "menu" } });
  expect(useUIStore.getState().terminalSecondaryClick).toBe("smart");
  expect(screen.getByRole("alert").textContent).toContain("blocks terminal apps");

  fireEvent.click(screen.getByRole("button", { name: "Use high-risk preset" }));
  expect(useUIStore.getState().terminalSecondaryClick).toBe("menu");
  fireEvent.change(secondaryClick, { target: { value: "disabled" } });
  expect(useUIStore.getState().terminalSecondaryClick).toBe("disabled");
  expect(screen.getByText(/Shift\+F10.*Command Palette.*Titlebar.*Sidebar/)).toBeTruthy();
  expect(screen.getByText(/multiline, large, or control-character/)).toBeTruthy();
});

test("advanced terminal bindings detect conflicts, require risky-key override, disable, and reset", () => {
  useUIStore.setState({
    configLoaded: false,
    settingsTab: "appearance",
    terminalSecondaryClick: "disabled",
    terminalHostModifier: "alt",
    keybindings: {
      ...defaultKeybindingsForPlatform("linux"),
      terminalMenu: "Ctrl+Shift+M",
    },
  });
  render(<Settings onClose={() => {}} />);
  fireEvent.click(screen.getByText("Advanced terminal shortcuts"));

  const copy = screen.getByLabelText("Capture shortcut for Copy terminal selection");
  fireEvent.keyDown(copy, { key: "F10", shiftKey: true });
  expect(screen.getByRole("alert").textContent).toContain("reserved recovery shortcuts");
  expect(useUIStore.getState().keybindings.copySelection).toBe("Ctrl+Shift+C");

  fireEvent.keyDown(copy, { key: "v", ctrlKey: true, shiftKey: true });
  expect(screen.getByRole("alert").textContent).toContain("Safe Paste");
  expect(useUIStore.getState().keybindings.copySelection).toBe("Ctrl+Shift+C");

  fireEvent.keyDown(copy, { key: "x" });
  expect(screen.getByRole("alert").textContent).toContain("intercept shell or TUI");
  expect(useUIStore.getState().keybindings.copySelection).toBe("Ctrl+Shift+C");

  fireEvent.keyDown(copy, { key: "c", ctrlKey: true });
  expect(screen.getByRole("alert").textContent).toContain("intercept shell or TUI");
  fireEvent.click(screen.getByRole("button", { name: "Use anyway (override terminal risk)" }));
  expect(useUIStore.getState().keybindings.copySelection).toBe("Ctrl+C");

  const menu = screen.getByLabelText("Capture shortcut for Additional menu shortcut");
  fireEvent.click(within(menu.parentElement!).getByRole("button", { name: "Disable" }));
  expect(useUIStore.getState().keybindings.terminalMenu).toBe("");
  expect(menu.getAttribute("placeholder")).toBe("Disabled");

  fireEvent.click(screen.getByRole("button", { name: "Restore platform defaults" }));
  expect(useUIStore.getState()).toMatchObject({
    terminalSecondaryClick: "smart",
    terminalHostModifier: "shift",
    keybindings: expect.objectContaining({
      terminalMenu: "",
      copySelection: "Ctrl+Shift+C",
      safePaste: "Ctrl+Shift+V",
    }),
  });
});

test("app bindings cannot take the fixed terminal menu recovery keys", () => {
  useUIStore.setState({
    configLoaded: false,
    settingsTab: "appearance",
    keybindings: defaultKeybindingsForPlatform("linux"),
  });
  render(<Settings onClose={() => {}} />);

  const appShortcut = screen.getByLabelText("Capture shortcut for New terminal");
  fireEvent.keyDown(appShortcut, { key: "ContextMenu" });

  expect(screen.getByRole("alert").textContent).toContain("reserved recovery shortcuts");
  expect(useUIStore.getState().keybindings.newTerminal).toBe("Mod+T");
});
