import { mockIPC } from "@tauri-apps/api/mocks";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useUIStore } from "@/state/ui";
import { Settings } from "@/ui/overlays/Settings";
import { useCliStatus } from "@/ui/overlays/settings/useCliStatus";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));
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
  vi.mocked(openPath).mockReset();
});

test("settings navigation indicates clicks and the section reached while scrolling", () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  render(<Settings onClose={() => {}} />);

  const appearance = screen.getByRole("button", { name: "Appearance" });
  const terminal = screen.getByRole("button", { name: "Terminal" });
  expect(appearance.getAttribute("aria-current")).toBe("page");

  fireEvent.click(terminal);
  expect(terminal.getAttribute("aria-current")).toBe("page");
  expect(document.activeElement).toBe(document.getElementById("settings-section-terminal"));
  expect(scrollIntoView).toHaveBeenCalled();

  const panel = document.getElementById("settings-tabpanel") as HTMLElement;
  panel.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  for (const [id, top] of [["appearance", 20], ["terminal", 40], ["ssh", 80], ["advanced", 140], ["about", 300]] as const) {
    const section = document.getElementById(`settings-section-${id}`) as HTMLElement;
    section.getBoundingClientRect = () => ({ top } as DOMRect);
  }
  fireEvent.scroll(panel);
  expect(screen.getByRole("button", { name: "Connections & transfers" }).getAttribute("aria-current")).toBe("page");
  expect(terminal.hasAttribute("aria-current")).toBe(false);
  scrollIntoView.mockRestore();
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
  fireEvent.click(screen.getByRole("button", { name: "Open" }));

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
