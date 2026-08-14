import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";

const { confirmMock, revealMock, saveMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  revealMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock, save: saveMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: revealMock }));
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

test("App settings explain privacy and provide opt-in, open, export, and clear actions", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  let enabled = false;
  let fileCount = 0;
  const status = () => ({
    enabled,
    directory: "/private/tunara/usage",
    fileCount,
    totalBytes: fileCount ? 512 : 0,
    retentionDays: 7,
    maxTotalBytes: 20 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
  });
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "legacy_agent_data_status") return "missing";
    if (command === "local_usage_log_status") return status();
    if (command === "local_usage_log_set_enabled") {
      enabled = Boolean((args as { enabled?: boolean }).enabled);
      fileCount = enabled ? 1 : fileCount;
      return status();
    }
    if (command === "local_usage_log_ensure_directory") return status().directory;
    if (command === "local_usage_log_export") return 512;
    if (command === "local_usage_log_clear") {
      fileCount = 0;
      return status();
    }
    throw new Error(`unexpected command: ${command}`);
  });
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  revealMock.mockReset();
  revealMock.mockResolvedValue(undefined);
  saveMock.mockReset();
  saveMock.mockResolvedValue("/private/export/tunara-usage-logs.jsonl");
  useUIStore.setState({
    configLoaded: false,
    settingsTab: "app",
    localUsageLoggingEnabled: false,
    configPath: undefined,
    configError: null,
  });

  render(<Settings onClose={() => {}} />);

  const toggle = await screen.findByRole("switch", { name: "Local usage logs" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByText(/Credentials, clipboard data, terminal input\/output/)).toBeTruthy();
  expect(screen.getByText("/private/tunara/usage")).toBeTruthy();

  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(calls).toContainEqual({ command: "local_usage_log_set_enabled", args: { enabled: true } });

  fireEvent.click(screen.getByRole("button", { name: "Open log directory" }));
  await waitFor(() => expect(revealMock).toHaveBeenCalledWith("/private/tunara/usage"));

  fireEvent.click(screen.getByRole("button", { name: "Export JSONL bundle" }));
  await waitFor(() => expect(calls).toContainEqual({
    command: "local_usage_log_export",
    args: { destination: "/private/export/tunara-usage-logs.jsonl" },
  }));

  fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
  await waitFor(() => expect(confirmMock).toHaveBeenCalled());
  await waitFor(() => expect(calls.some(({ command }) => command === "local_usage_log_clear")).toBe(true));
  expect(await screen.findByText("Local usage logs cleared.")).toBeTruthy();
});
