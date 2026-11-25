import type { Page } from "@playwright/test";
import type { DirEntry } from "../src/modules/fs/fs-bridge";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 1280, height: 620 } });

async function mockListing(page: Page) {
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    const entry = (name: string, kind: DirEntry["kind"] = "file"): DirEntry => ({
      name, kind, mtime: Date.UTC(2025, 2, 3, 12), size: 42,
    });
    window.__TAURI_INTERNALS__.invoke = (cmd: string, args?: Record<string, unknown>) => {
      // Use the filesystem root as home so both revisions show the same absolute breadcrumbs.
      if (cmd === "ssh_fs_home" || (cmd === "fs_resolve_dir" && args?.path === "~")) return Promise.resolve("/");
      if (cmd === "fs_read_dir" || cmd === "ssh_fs_read_dir") {
        void invoke(cmd, args);
        if (args?.path === "/") return Promise.resolve([entry("home", "dir")]);
        if (args?.path === "/home") return Promise.resolve([entry("e2e", "dir")]);
        if (args?.path === "/home/e2e/src") {
          return Promise.resolve([
            entry("explorer.tsx"), entry("file-tree.tsx"), entry("index.ts"),
            ...(args.id === 2 ? [entry("refreshed.ts")] : []),
          ]);
        }
        return Promise.resolve([
          ...["assets", "bin", "config", "docs", "scripts", "src", "tests"].map((name) => entry(name, "dir")),
          entry("README.md"),
          ...Array.from({ length: 38 }, (_, i) => entry(`test-${String(i).padStart(2, "0")}.md`)),
          ...(args?.id === 2 ? [entry("updated-on-reconnect.md")] : []),
        ]);
      }
      return invoke(cmd, args);
    };
  });
}

async function expectListingBreadcrumb(page: Page) {
  const breadcrumbs = page.getByRole("navigation", { name: "Directory" }).locator(".explorer-breadcrumbs");
  await expect(breadcrumbs).toHaveAttribute("title", "/home/e2e");
  await expect(breadcrumbs.getByRole("button")).toHaveText(["/", "home", "e2e"]);
}

async function browseFiles(page: Page) {
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const root = page.getByRole("navigation", { name: "Directory" }).getByRole("button", { name: "/", exact: true });
  await expect(root).toBeVisible();
  if (await root.isEnabled()) await root.click();
  await page.getByRole("treeitem", { name: "home", exact: true }).press("Enter");
  await page.getByRole("treeitem", { name: "e2e", exact: true }).press("Enter");
  await expectListingBreadcrumb(page);
  const folder = page.getByRole("treeitem", { name: "src", exact: true });
  await folder.click();
  const file = page.getByRole("treeitem", { name: "file-tree.tsx", exact: true });
  await expect(file).toBeVisible();
  const list = page.getByRole("tree").locator("..");
  await list.evaluate((element) => { element.scrollTop = 128; });
  expect(await list.evaluate((element) => element.scrollTop)).toBe(128);
  return { folder, file, list };
}

async function capturePanel(page: Page, scenario: string) {
  const prefix = process.env.FILE_PANEL_CAPTURE;
  if (!prefix) return;
  await page.mouse.move(640, 12);
  await page.locator(".tunara-panel").screenshot({ path: `${prefix}-${scenario}.png`, animations: "disabled" });
}

test("Files keeps expanded folders and the scroll position after visiting Changes", async ({ page }) => {
  await page.goto("/");
  await mockListing(page);
  await page.getByRole("button", { name: "Local terminal" }).click();
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$");
  const { folder, file, list } = await browseFiles(page);
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(folder).toBeVisible();
  await expectListingBreadcrumb(page);
  await capturePanel(page, "tabs");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(file).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBe(128);
});

test("Files keeps a read-only snapshot on SSH disconnect and refreshes on reconnect", async ({ page, backend }) => {
  await page.goto("/");
  await mockListing(page);
  await page.getByRole("button", { name: "Connect SSH" }).click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
  await dialog.locator("#ssh-connect-host").fill("deploy@example.test");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$");
  const { folder, file, list } = await browseFiles(page);
  const snapshot = page.getByText("SSH disconnected · Read-only snapshot", { exact: true });
  await expect(snapshot).toHaveCount(0);
  await file.press("Control+Space");
  await expect(file).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.__TUNARA_E2E__!.disconnectPty(1));
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(snapshot.or(page.getByText("Remote files are unavailable", { exact: true }))).toBeVisible();
  await expectListingBreadcrumb(page);
  await capturePanel(page, "disconnect");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(snapshot).toBeVisible();
  await expect(file).toHaveAttribute("aria-selected", "true");
  expect(await list.evaluate((element) => element.scrollTop)).toBe(128);
  await expect(page.getByRole("button", { name: "Favorite and recent directories" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Upload file…" })).toBeDisabled();
  await expect(file.getByRole("button")).toHaveCount(0);
  const readCount = await backend.callCount("ssh_fs_read_file");
  await file.press("Enter");
  await file.press("Shift+F10");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await backend.callCount("ssh_fs_read_file")).toBe(readCount);

  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => backend.openPtyIds()).toEqual([2]);
  await expect(page.getByRole("treeitem", { name: "updated-on-reconnect.md" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "refreshed.ts" })).toBeVisible();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(file.getByRole("button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Upload file…" })).toBeEnabled();
  await expect(snapshot).toHaveCount(0);
});
