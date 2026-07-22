import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmMock }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/ui/overlays/useAppUpdate", () => ({
  useAppUpdate: () => ({
    appVersion: "1.17.0",
    updateStatus: "current",
    updateVersion: "",
    updateProgress: null,
    canInstallUpdate: false,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
  }),
}));

test("legacy Agent history is deleted only after explicit confirmation", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "legacy_agent_data_status") return "present";
    if (command === "legacy_agent_data_delete") return "missing";
    throw new Error(`unexpected command: ${command}`);
  });
  confirmMock.mockReset();
  useUIStore.setState({
    configLoaded: false,
    settingsTab: "app",
    configPath: null,
    configError: null,
  });

  render(<Settings onClose={() => {}} />);
  const deleteButton = await screen.findByRole("button", { name: "Delete legacy data" });
  expect(screen.getByText(/current versions no longer read/)).toBeTruthy();

  confirmMock.mockResolvedValueOnce(false);
  fireEvent.click(deleteButton);
  await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
  expect(calls.filter(({ command }) => command === "legacy_agent_data_delete")).toHaveLength(0);

  confirmMock.mockResolvedValueOnce(true);
  fireEvent.click(deleteButton);
  await waitFor(() => {
    expect(calls.filter(({ command }) => command === "legacy_agent_data_delete")).toEqual([
      { command: "legacy_agent_data_delete", args: { confirmed: true } },
    ]);
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Delete legacy data" })).toBeNull());
});
