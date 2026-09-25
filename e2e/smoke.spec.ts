import { expect, focusedTerminalSessionId, openLocalTerminal, terminalSessionIds, test } from "./fixtures";

test.use({ locale: "en-US" });

test("boots and shows a terminal backed by the mocked PTY", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  expect(await backend.callCount("load_config")).toBeGreaterThan(0);
  expect(await backend.callCount("ssh_hosts_load")).toBeGreaterThan(0);
});

test("typing echoes through the mocked PTY", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  await page.keyboard.type("echo hello-e2e");
  await page.keyboard.press("Enter");
  await expect.poll(() => backend.ptyWrites(1)).toBe("echo hello-e2e\r");
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$ echo hello-e2e");

  await backend.emitPtyOutput(1, "\r\nfrom-backend\r\n");
  await expect(page.locator(".xterm-rows").first()).toContainText("from-backend");
});

test("⌘D splits the pane and focus switches between panes", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".xterm")).toHaveCount(2);
  await expect.poll(() => backend.openPtyIds()).toEqual([1, 2]);
  const [leftPane, rightPane] = await terminalSessionIds(page);

  await expect.poll(() => focusedTerminalSessionId(page)).toBe(rightPane);
  await page.keyboard.type("right");
  await expect.poll(() => backend.ptyWrites(2)).toBe("right");

  await page.keyboard.press("Meta+[");
  await expect.poll(() => focusedTerminalSessionId(page)).toBe(leftPane);
  await page.keyboard.type("left");
  await expect.poll(() => backend.ptyWrites(1)).toBe("left");

  await page.keyboard.press("Meta+]");
  await expect.poll(() => focusedTerminalSessionId(page)).toBe(rightPane);
  await page.keyboard.type("!");
  await expect.poll(() => backend.ptyWrites(2)).toBe("right!");
});

test("⌘K opens the command palette and runs an action", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Type a command or search…" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("Type a command or search…").first().fill("Split horizontally");
  await palette.getByRole("option", { name: /Split horizontally/ }).first().click();
  await expect(palette).toBeHidden();
  await expect(page.locator(".xterm")).toHaveCount(2);
  await expect.poll(() => backend.openPtyIds()).toEqual([1, 2]);
});

test("Inspector switches between Changes and Files", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  const tabs = page.getByRole("tablist", { name: "Inspector views" });
  const changes = tabs.getByRole("tab", { name: "Changes" });
  const files = tabs.getByRole("tab", { name: "Files" });

  await changes.click();
  await expect(changes).toHaveAttribute("aria-selected", "true");
  await expect(files).toHaveAttribute("aria-selected", "false");

  await files.click();
  await expect(files).toHaveAttribute("aria-selected", "true");
  await expect(changes).toHaveAttribute("aria-selected", "false");
});

test("Settings opens and every section is reachable", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  await page.keyboard.press("Meta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const nav = dialog.getByRole("navigation");
  const sections = [
    ["appearance", "Appearance"],
    ["terminal", "Terminal"],
    ["ssh", "Connections & transfers"],
    ["advanced", "Advanced"],
    ["about", "About"],
  ] as const;
  for (const [id, label] of sections) {
    const button = nav.getByRole("button", { name: label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(dialog.locator(`#settings-section-${id}`)).toBeInViewport();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("SSH connect overlay opens and validates the form", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect SSH" }).click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
  await expect(dialog).toBeVisible();

  const host = dialog.locator("#ssh-connect-host");
  const connect = dialog.getByRole("button", { name: "Connect", exact: true });
  await expect(host).toBeFocused();
  await expect(dialog.getByRole("option", { name: /staging/ })).toBeVisible();
  await expect(connect).toBeDisabled();

  await host.fill("deploy@example.test:99999");
  await expect(host).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toContainText("Port must be a number between 1 and 65535");
  await expect(connect).toBeDisabled();

  await host.fill("deploy@example.test:2222");
  await expect(host).toHaveAttribute("aria-invalid", "false");
  await expect(dialog.getByText("Port must be a number between 1 and 65535")).toHaveCount(0);
  await expect(connect).toBeEnabled();
  expect(await backend.callCount("ssh_open_v2")).toBe(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
