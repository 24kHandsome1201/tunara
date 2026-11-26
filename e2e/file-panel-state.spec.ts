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
      if (cmd === "fs_canonical_path" && args?.path === "/home/e2e/src") return Promise.resolve(args.path);
      if (cmd === "fs_read_dir" || cmd === "ssh_fs_read_dir") {
        void invoke(cmd, args);
        if (args?.path === "/") return Promise.resolve([entry("home", "dir")]);
        if (args?.path === "/home") return Promise.resolve([entry("e2e", "dir")]);
        if (args?.path === "/home/e2e/src") {
          return Promise.resolve([
            entry("components", "dir"), entry("lib", "dir"),
            entry("explorer.tsx"), entry("file-tree.tsx"), entry("index.ts"),
            ...Array.from({ length: 30 }, (_, i) => entry(`module-${String(i).padStart(2, "0")}.ts`)),
            ...(args.id === 2 ? [entry("refreshed.ts")] : []),
          ]);
        }
        if (args?.path === "/home/e2e/src/index.ts") return Promise.reject(new Error("Not a directory"));
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

async function expectListingBreadcrumb(page: Page, inSource = true) {
  const breadcrumbs = page.getByRole("navigation", { name: "Directory" }).locator(".explorer-breadcrumbs");
  await expect(breadcrumbs).toHaveAttribute("title", inSource ? "/home/e2e/src" : "/home/e2e");
  await expect(breadcrumbs.getByRole("button")).toHaveText(["/", "home", "e2e", ...(inSource ? ["src"] : [])]);
}

async function browseFiles(page: Page, capture: string) {
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const root = page.getByRole("navigation", { name: "Directory" }).getByRole("button", { name: "/", exact: true });
  await expect(root).toBeVisible();
  if (await root.isEnabled()) await root.click();
  await page.getByRole("treeitem", { name: "home", exact: true }).press("Enter");
  await page.getByRole("treeitem", { name: "e2e", exact: true }).press("Enter");
  const folder = page.getByRole("treeitem", { name: "src", exact: true });
  await expect(folder).not.toHaveAttribute("aria-expanded");
  await folder.click();
  const file = page.getByRole("treeitem", { name: "file-tree.tsx", exact: true });
  await expect(file).toBeVisible();
  await expectListingBreadcrumb(page);
  await expect(folder).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toHaveCount(0);
  await capturePanel(page, capture);
  const list = page.getByRole("tree").locator("..");
  await list.evaluate((element) => { element.scrollTop = 128; });
  expect(await list.evaluate((element) => element.scrollTop)).toBe(128);
  return { file, list };
}

async function capturePanel(page: Page, scenario: string) {
  const prefix = process.env.FILE_PANEL_CAPTURE;
  if (!prefix) return;
  await page.mouse.move(640, 12);
  await page.locator(".tunara-panel").screenshot({ path: `${prefix}-${scenario}.png`, animations: "disabled" });
}

for (const target of ["directory", "file"] as const) {
  test(`Files jumps to an absolute ${target} on Enter`, async ({ page, backend }) => {
    await page.goto("/");
    await mockListing(page);
    await page.getByRole("button", { name: "Local terminal" }).click();
    await expect(page.locator(".xterm-rows").first()).toContainText("e2e$");
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const root = page.getByRole("navigation", { name: "Directory" }).getByRole("button", { name: "/", exact: true });
    await expect(root).toBeVisible();
    if (await root.isEnabled()) await root.click();
    await expect(page.getByRole("treeitem", { name: "home", exact: true })).toBeVisible();
    const search = page.getByRole("textbox", { name: "Search this folder" });
    await search.fill(target === "directory" ? "/home/e2e/src" : "/home/e2e/src/index.ts");
    const fileReads = await backend.callCount("fs_read_file");
    await search.press("Enter");
    await expect(search).toBeEmpty();
    await expect(page.locator(".explorer-breadcrumbs")).toHaveAttribute("title", "/home/e2e/src");
    const rows = page.getByRole("treeitem");
    if (target === "file") {
      await expect(rows.first()).toHaveAttribute("aria-label", "index.ts");
      await expect(rows.first()).toHaveAttribute("data-pinned", "true");
    } else {
      await expect(rows.first()).toHaveAttribute("aria-label", "components");
    }
    expect(await backend.callCount("fs_read_file")).toBe(fileReads);
    await capturePanel(page, `path-${target}`);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("treeitem", { name: "home", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Forward", exact: true }).click();
    await expectListingBreadcrumb(page);
  });
}

test("Files keeps the current directory and scroll position after visiting Changes", async ({ page }) => {
  await page.goto("/");
  await mockListing(page);
  await page.getByRole("button", { name: "Local terminal" }).click();
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$");
  const { file, list } = await browseFiles(page, "local");
  await page.getByRole("tab", { name: "Changes", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expectListingBreadcrumb(page);
  await capturePanel(page, "tabs");
  await expect(file).toBeVisible();
  expect(await list.evaluate((element) => element.scrollTop)).toBe(128);

  const nav = page.getByRole("navigation", { name: "Directory" });
  const back = nav.getByRole("button", { name: "Back", exact: true });
  const forward = nav.getByRole("button", { name: "Forward", exact: true });
  await back.click();
  await expectListingBreadcrumb(page, false);
  await forward.click();
  await expect(file).toBeVisible();
  await nav.getByRole("button", { name: "e2e", exact: true }).click();
  await expectListingBreadcrumb(page, false);
  await nav.getByRole("button", { name: "Edit path" }).click();
  const address = nav.getByRole("textbox", { name: "Directory path" });
  await expect(address).toHaveValue("/home/e2e");
  await address.fill("/home/e2e/src");
  await capturePanel(page, "edit");
  await address.press("Enter");
  await expectListingBreadcrumb(page);
  await expect(file).toBeVisible();
});

test("Files keeps a read-only snapshot on SSH disconnect and refreshes on reconnect", async ({ page, backend }) => {
  await page.goto("/");
  await mockListing(page);
  await page.getByRole("button", { name: "Connect SSH" }).click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
  await dialog.locator("#ssh-connect-host").fill("deploy@example.test");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$");
  const { file, list } = await browseFiles(page, "ssh");
  const snapshot = page.getByText("SSH disconnected · Read-only snapshot", { exact: true });
  await expect(snapshot).toHaveCount(0);
  await file.press("Control+Space");
  await expect(file).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.__TUNARA_E2E__!.disconnectPty(1));
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await expect(snapshot.or(page.getByText("Remote files are unavailable", { exact: true }))).toBeVisible();
  await expectListingBreadcrumb(page);
  await capturePanel(page, "disconnect");
  await expect(snapshot).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit path" })).toBeDisabled();
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
  await expect(page.getByRole("treeitem", { name: "refreshed.ts" })).toBeVisible();
  await expectListingBreadcrumb(page);
  await expect(file.getByRole("button", { name: "More actions: file-tree.tsx" })).toBeVisible();
  await file.hover();
  await expect(file.getByRole("button", { name: "Send path to terminal: file-tree.tsx" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload file…" })).toBeEnabled();
  await expect(snapshot).toHaveCount(0);
  await page.getByRole("navigation", { name: "Directory" }).getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "updated-on-reconnect.md" })).toBeVisible();
});
