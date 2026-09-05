import { mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { lazy, Suspense } from "react";
import { AGENT_REGISTRY } from "@/modules/agent/registry";
import { defaultKeybindingsForPlatform } from "@/modules/config/keybindings";
import { useKeybindings } from "@/app/useKeybindings";
import { consumePendingSettingsSection, useUIStore } from "@/state/ui";
import { PanelLoadingState } from "@/ui/shared";
import { isMac } from "@/ui/lib/platform";
import { CliSettings } from "@/ui/overlays/settings/CliSettings";

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

const Settings = lazy(() => import("@/ui/overlays/Settings").then((module) => ({ default: module.Settings })));

function LazySettingsShell() {
  useKeybindings();
  const overlay = useUIStore((s) => s.overlay);
  const setOverlay = useUIStore((s) => s.setOverlay);
  if (overlay !== "settings") return null;
  return (
    <Suspense fallback={<PanelLoadingState label="Loading…" />}>
      <Settings onClose={() => setOverlay(null)} />
    </Suspense>
  );
}

beforeEach(() => {
  mockIPC((command) => command === "resolve_all_bins" ? [] : undefined);
  consumePendingSettingsSection();
  useUIStore.setState({
    configLoaded: false,
    overlay: null,
    keybindings: defaultKeybindingsForPlatform("linux"),
  });
});

afterEach(() => {
  consumePendingSettingsSection();
});

test("CLI settings renders the registry and preserves override identifiers", () => {
  const applyOverride = vi.fn();
  render(<CliSettings
    resolvedClis={[{ name: "CR", path: "/usr/bin/cursor-agent", source: "systemPath" }]}
    cliError={false}
    preflights={{}}
    loadCliStatus={vi.fn()}
    applyOverride={applyOverride}
  />);

  for (const { name } of AGENT_REGISTRY) expect(screen.getByText(name)).toBeTruthy();
  expect(screen.getByText(`Found 1/${AGENT_REGISTRY.length}`)).toBeTruthy();
  const buttons = screen.getAllByRole("button", { name: "Set custom path" });
  expect(buttons).toHaveLength(AGENT_REGISTRY.length);
  fireEvent.click(buttons[AGENT_REGISTRY.findIndex(({ code }) => code === "CR")]);
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("/usr/bin/cursor-agent");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/opt/cursor-agent" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(applyOverride).toHaveBeenCalledWith("CR", "cursor-agent", "/opt/cursor-agent");
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("⌘, opens the lazy Settings overlay", async () => {
  const addEventListener = vi.spyOn(window, "addEventListener");
  render(<LazySettingsShell />);
  const registration = addEventListener.mock.calls.find(([type]) => type === "keydown");
  expect(registration).toBeTruthy();

  const event = {
    key: ",",
    ctrlKey: !isMac,
    metaKey: isMac,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
  act(() => {
    (registration?.[1] as EventListener)(event);
  });
  expect(event.preventDefault).toHaveBeenCalled();
  expect(useUIStore.getState().overlay).toBe("settings");
  expect(await screen.findByRole("dialog", { name: "Settings" })).toBeTruthy();
});

test("pending settings section survives lazy load and scrolls into view", async () => {
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;

  try {
    useUIStore.getState().openSettings("app");
    expect(useUIStore.getState().overlay).toBe("settings");
    render(<LazySettingsShell />);
    expect(await screen.findByRole("heading", { name: "About" })).toBeTruthy();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const scrolled = scrollIntoView.mock.instances[0] as HTMLElement | undefined;
    expect(scrolled?.id).toBe("settings-section-about");
    expect(consumePendingSettingsSection()).toBeNull();
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  }
});
