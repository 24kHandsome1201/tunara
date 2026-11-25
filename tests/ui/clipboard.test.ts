import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { copyText, readClipboardText } from "@/ui/lib/clipboard";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn(), writeText: vi.fn() }));

beforeEach(() => {
  vi.mocked(readText).mockReset();
  vi.mocked(writeText).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("Tauri copy replaces stale system text even if the WebView reports a successful no-op", async () => {
  vi.stubGlobal("isTauri", true);
  const webWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  let systemClipboard = "previous text";
  vi.mocked(writeText).mockImplementation(async (text) => { systemClipboard = text; });

  await expect(copyText("new text")).resolves.toBe(true);
  expect(systemClipboard).toBe("new text");
  expect(webWrite).not.toHaveBeenCalled();
});

test("Tauri copy reports native failure without falling back to the WebView", async () => {
  vi.stubGlobal("isTauri", true);
  const webWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  vi.mocked(writeText).mockRejectedValue(new Error("clipboard unavailable"));

  await expect(copyText("new text")).resolves.toBe(false);
  expect(writeText).toHaveBeenCalledWith("new text");
  expect(webWrite).not.toHaveBeenCalled();
});

test("menu clipboard reads use Tauri clipboard-manager text access", async () => {
  vi.mocked(readText).mockResolvedValue("menu text");
  await expect(readClipboardText()).resolves.toBe("menu text");
  expect(readText).toHaveBeenCalledOnce();
});

test("empty and image-only clipboards are no-op text reads", async () => {
  for (const error of [
    "The clipboard contents were not available in the requested format.",
    new Error("The clipboard is empty."),
  ]) {
    vi.mocked(readText).mockRejectedValueOnce(error);
    await expect(readClipboardText()).resolves.toBe("");
  }
});

test("permission failures propagate without being logged or rewritten with clipboard data", async () => {
  const error = new Error("permission denied");
  vi.mocked(readText).mockRejectedValue(error);
  await expect(readClipboardText()).rejects.toBe(error);
});
