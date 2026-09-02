import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { defaultKeybindingsForPlatform } from "@/modules/config/keybindings";
import { useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));
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

test("host modifier control remains on the single settings page", () => {
  useUIStore.setState({
    configLoaded: false,
    theme: "dark",
    terminalHostModifier: "shift",
    keybindings: defaultKeybindingsForPlatform("linux"),
  });
  mockIPC((command) => command === "resolve_all_bins" ? [] : undefined);
  render(<Settings onClose={() => {}} />);

  expect(screen.getByLabelText("Terminal host modifier").classList).toContain("settings-control");
  expect(screen.getByText("ESC").tagName).toBe("KBD");
  expect(screen.getByText("ESC").classList).toContain("settings-key-hint");
  expect(screen.getByText("Keyboard shortcuts can be changed in the config file.")).toBeTruthy();
});
