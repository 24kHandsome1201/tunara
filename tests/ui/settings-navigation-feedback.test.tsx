import { mockIPC } from "@tauri-apps/api/mocks";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { loadUserConfig, useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";
import { useCliStatus } from "@/ui/overlays/settings/useCliStatus";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/ui/overlays/useAppUpdate", () => ({
  useAppUpdate: () => ({
    appVersion: "2.0.1", updateStatus: "current", updateVersion: "", updateProgress: null,
    canInstallUpdate: false, checkForUpdates: vi.fn(), installUpdate: vi.fn(),
  }),
}));

beforeEach(() => {
  mockIPC((command) => command === "resolve_all_bins" ? [] : undefined);
  useUIStore.setState({ configPath: "/private/config.json", configError: null });
  vi.mocked(confirm).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(openPath).mockReset();
});

test("everyday controls stay visible while Advanced starts collapsed", () => {
  render(<Settings onClose={() => {}} />);

  const advanced = screen.getByRole("button", { name: "Advanced" });
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open config file" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Connections & transfers" })).toBeNull();

  fireEvent.click(advanced);
  expect(advanced.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("heading", { name: "Connections & transfers" })).toBeTruthy();
  fireEvent.click(advanced);
  expect(screen.queryByRole("heading", { name: "Connections & transfers" })).toBeNull();
});

test("folder selection and Home reset persist through config loads", async () => {
  const folder = "/home/ubuntu/My Project";
  let saved = { appearance: {}, keybindings: {} };
  mockIPC((command, payload) => {
    if (command === "resolve_all_bins") return [];
    if (command === "save_config") saved = (payload as { config: typeof saved }).config;
    if (command === "load_config") return { path: "/config.toml", config: saved, error: null };
    return undefined;
  });
  await loadUserConfig();
  vi.mocked(open).mockResolvedValueOnce(folder).mockResolvedValueOnce(null);
  try {
    render(<Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose default folder: Home folder" }));
    await screen.findByRole("button", { name: `Choose default folder: ${folder}` });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
    await waitFor(() => expect(saved.appearance).toMatchObject({ default_terminal_folder: folder }));

    await act(loadUserConfig);
    const chooser = screen.getByRole("button", { name: `Choose default folder: ${folder}` });
    await act(async () => { fireEvent.click(chooser); });
    expect(useUIStore.getState().defaultTerminalFolder).toBe(folder);

    fireEvent.click(screen.getByRole("button", { name: "Reset to Home" }));
    await waitFor(() => expect(saved.appearance).toMatchObject({ default_terminal_folder: "" }));
    await act(loadUserConfig);
    expect(screen.getByRole("button", { name: "Choose default folder: Home folder" })).toBeTruthy();
  } finally {
    useUIStore.setState({ configLoaded: false });
  }
});

test("failed override reset and config open show inline generic alerts", async () => {
  mockIPC((command) => {
    if (command === "resolve_all_bins") return [];
    if (command === "clear_bin_overrides") throw new Error("sensitive backend detail");
    return undefined;
  });
  vi.mocked(confirm).mockResolvedValue(true);
  vi.mocked(openPath).mockRejectedValue(new Error("sensitive path detail"));
  render(<Settings onClose={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset all custom paths" }));
  fireEvent.click(screen.getByRole("button", { name: "Open config file" }));

  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  const feedback = screen.getAllByRole("alert").map((alert) => alert.textContent);
  expect(feedback).toEqual(expect.arrayContaining([
    "Could not reset custom CLI paths. Try again.",
    "Could not open the config file.",
  ]));
  expect(document.body.textContent).not.toContain("sensitive");
});

test("CLI path write failure is reported and clears on a successful retry", async () => {
  let failing = true;
  mockIPC((command) => {
    if (command === "resolve_all_bins") return [];
    if (command === "set_bin_override" && failing) throw new Error("write failed");
    return undefined;
  });
  const { result } = renderHook(() => useCliStatus());
  act(() => result.current.applyOverride("CC", "claude", "/bin/claude"));
  await waitFor(() => expect(result.current.overrideError).toBe(true));
  failing = false;
  act(() => result.current.applyOverride("CC", "claude", "/bin/claude"));
  await waitFor(() => expect(result.current.overrideError).toBe(false));
});
