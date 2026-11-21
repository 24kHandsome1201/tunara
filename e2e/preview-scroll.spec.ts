import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({ locale: "en-US", reducedMotion: "reduce" });

const markdown = `# Preview scrolling\n\n${Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1}: Long documents should remain readable with a mouse wheel or trackpad.\n`).join("\n")}\n## Destination\n\n${"More content below the destination.\n\n".repeat(30)}`;
const rows = Array.from({ length: 150 }, (_, i) => ({ name: `Record ${i + 1}`, value: i }));

async function openPreview(page: Page, name: string, content: string) {
  await page.goto("/");
  await page.evaluate(({ name, content }) => {
    const original = window.__TAURI_INTERNALS__.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    window.__TAURI_INTERNALS__.invoke = (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "fs_resolve_dir") return Promise.resolve("/home/e2e");
      if (cmd === "fs_read_dir") return Promise.resolve([{ name, kind: "file", size: content.length, mtime: 0 }]);
      if (cmd === "fs_read_file") return Promise.resolve({ kind: "text", content, size: content.length, fingerprint: "a".repeat(64) });
      return original(cmd, args);
    };
  }, { name, content });
  await page.getByRole("button", { name: "Local terminal", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.locator(`[data-file-path="/home/e2e/${name}"]`).click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Preview", exact: true })).toHaveAttribute("aria-selected", "true");
  return page.locator(".file-editor-paper > div").first();
}

async function wheel(page: Page, root: Locator, delta: number) {
  const box = await root.boundingBox();
  if (!box) throw new Error("Preview has no bounds");
  const paper = await page.locator(".file-editor-paper").boundingBox();
  if (!paper) throw new Error("Editor has no bounds");
  await page.mouse.move(box.x + box.width / 2, paper.y + paper.height / 2);
  await page.mouse.wheel(0, delta);
}

test("long Markdown preview wheel-scrolls down", async ({ page }) => {
  const root = await openPreview(page, "guide.md", markdown);
  await wheel(page, root, 650);
  if (process.env.PREVIEW_SCROLL_SCREENSHOT) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.PREVIEW_SCROLL_SCREENSHOT });
    console.log(await root.evaluate((el) => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, parentHeight: el.parentElement?.clientHeight, parentOverflow: getComputedStyle(el.parentElement!).overflow })));
  }
  await expect.poll(() => root.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("Markdown TOC jump permits wheel-scrolling back up", async ({ page }) => {
  const root = await openPreview(page, "guide.md", markdown);
  await page.getByRole("link", { name: "Destination", exact: true }).click();
  const scrollTop = () => root.evaluate((el) => el.scrollTop + el.parentElement!.scrollTop);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  const jumped = await scrollTop();
  await wheel(page, root, -650);
  await expect.poll(scrollTop).toBeLessThan(jumped);
});

for (const [name, content] of [
  ["records.csv", `name,value\n${rows.map((row) => `${row.name},${row.value}`).join("\n")}`],
  ["records.json", JSON.stringify(rows)],
]) {
  test(`${name} table preview wheel-scrolls down`, async ({ page }) => {
    const root = await openPreview(page, name, content);
    await expect(root.locator("table")).toBeVisible();
    await wheel(page, root, 650);
    await expect.poll(() => root.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
}
