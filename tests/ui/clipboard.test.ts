import { beforeEach, expect, test, vi } from "vitest";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { readClipboardText } from "@/ui/lib/clipboard";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ readText: vi.fn() }));

beforeEach(() => {
  vi.mocked(readText).mockReset();
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
