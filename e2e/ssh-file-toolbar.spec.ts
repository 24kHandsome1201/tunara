import { expect, test } from "./fixtures";

test("SSH Files keeps favorites and file upload one click away and reveals selection on demand", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__ as typeof window.__TAURI_INTERNALS__ & {
      invoke: (command: string, args?: { path?: string }) => Promise<unknown>;
    };
    const invoke = internals.invoke.bind(internals);
    internals.invoke = (command, args) => {
      if (command === "ssh_fs_read_dir" && args?.path === "/home/e2e") {
        return Promise.resolve([
          { name: "compose.yaml", kind: "file", size: 1024, mtime: 0 },
          { name: "deploy.sh", kind: "file", size: 1024, mtime: 0 },
        ]);
      }
      return invoke(command, args);
    };
  });

  await page.getByRole("button", { name: "Connect SSH" }).click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
  await dialog.locator("#ssh-connect-host").fill("deploy@example.test");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();

  const toolbar = page.getByRole("toolbar", { name: "Remote file tools" });
  const more = toolbar.getByRole("button", { name: "More file actions" });
  const favorites = toolbar.getByRole("button", { name: "Favorite and recent directories" });
  const item = page.getByRole("treeitem", { name: "compose.yaml" });
  const checkbox = item.getByRole("checkbox", { name: "Select compose.yaml for download" });
  const selectAll = page.getByRole("checkbox", { name: "Select all downloadable files" });
  const menu = page.getByRole("menu");

  await expect(item).toBeVisible();
  await expect(checkbox).toHaveCount(0);
  await expect(selectAll).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Upload file…" })).toBeEnabled();
  await expect(toolbar.getByRole("button")).toHaveCount(3);

  await more.click();
  await expect(menu.getByRole("menuitem", { name: "Go to filesystem root" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Go to home directory" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Upload folder…" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "Download selected files (0)" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Favorite this directory" }).click();

  await favorites.click();
  await expect(menu.getByRole("menuitem", { name: "/home/e2e" }).first()).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(favorites).toBeFocused();

  await more.click();
  await menu.getByRole("menuitem", { name: "Select files" }).click();
  await expect(checkbox).not.toBeChecked();
  await expect(selectAll).toBeVisible();
  await selectAll.check();

  await more.click();
  await expect(menu.getByRole("menuitem", { name: "Download selected files (2)" })).toBeEnabled();
  await menu.getByRole("menuitem", { name: "Exit selection" }).click();
  await expect(checkbox).toHaveCount(0);
  await expect(selectAll).toHaveCount(0);

  await item.press("Space");
  await expect(checkbox).toBeChecked();
  await item.press("Shift+F10");
  await expect(menu.getByRole("menuitem", { name: "Download…", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await item.press("Space");
  await expect(checkbox).toHaveCount(0);

  await more.click();
  await menu.getByRole("menuitem", { name: "Go to filesystem root" }).click();
  await expect(item).toHaveCount(0);
  await more.click();
  await menu.getByRole("menuitem", { name: "Go to home directory" }).click();
  await expect(item).toBeVisible();
});
