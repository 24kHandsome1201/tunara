import { expect, focusedTerminalSessionId, openLocalTerminal, terminalSessionIds, test } from "./fixtures";

test.use({ locale: "en-US" });

test("boots and shows a terminal backed by the mocked PTY", async ({ page, backend }) => {
  await openLocalTerminal(page, backend);
  expect(await backend.callCount("load_config")).toBeGreaterThan(0);
  expect(await backend.callCount("ssh_hosts_load")).toBeGreaterThan(0);
});

test("empty workspace has an accessible title and stacks its launch cards in a narrow window", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start a terminal", level: 2 })).toBeVisible();
  const folder = page.getByRole("button", { name: "Open folder", exact: true });
  const ssh = page.getByRole("button", { name: "Connect SSH", exact: true });
  const folderWide = await folder.boundingBox();
  const sshWide = await ssh.boundingBox();
  expect(folderWide!.width).toBeCloseTo(sshWide!.width);
  expect(folderWide!.y).toBeCloseTo(sshWide!.y);

  await page.setViewportSize({ width: 640, height: 720 });
  const folderNarrow = await folder.boundingBox();
  const sshNarrow = await ssh.boundingBox();
  expect(folderNarrow!.width).toBeCloseTo(sshNarrow!.width);
  expect(folderNarrow!.x).toBeCloseTo(sshNarrow!.x);
  expect(folderNarrow!.y + folderNarrow!.height).toBeLessThan(sshNarrow!.y);
});

test("Inspector auto-collapses in a narrow window and restores when wide", async ({ page, backend }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLocalTerminal(page, backend);
  const inspector = page.locator(".tunara-panel");
  await expect(inspector).toBeVisible();

  await page.setViewportSize({ width: 820, height: 900 });
  await expect(inspector).toHaveAttribute("aria-hidden", "true");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(inspector).toBeVisible();
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

for (const method of ["button", "shortcut"] as const) {
  test(`New terminal takes keyboard focus from an open diff reader (${method})`, async ({ page, backend }) => {
    await openLocalTerminal(page, backend);
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      window.__TAURI_INTERNALS__.invoke = (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "git_status") return Promise.resolve({
          branch: "main",
          files: [{ path: "app.ts", status: "M", stage: "unstaged", added: 1, removed: 1 }],
        });
        if (cmd === "git_diff") return Promise.resolve({
          kind: "text", path: "app.ts", patch: "@@ -1 +1 @@\n-old value\n+new value\n", truncated: false, totalLines: 3,
        });
        return invoke(cmd, args);
      };
    });
    await backend.emitPtyOutput(1, "\x1b]7;file://localhost/home/e2e/project\x07");
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "app.ts", exact: true }).click();
    const diff = page.getByText("new value", { exact: false });
    await expect(diff).toBeVisible();

    if (method === "shortcut") {
      const search = page.getByRole("textbox", { name: "Search in this file…" });
      await search.click();
      await expect(search).toBeFocused();
      await page.keyboard.press("Meta+t");
    } else {
      await page.getByRole("button", { name: "New terminal", exact: true }).click();
    }
    await expect.poll(() => backend.openPtyIds()).toEqual([1, 2]);
    const [, newSessionId] = await terminalSessionIds(page);
    await expect.poll(() => focusedTerminalSessionId(page)).toBe(newSessionId);
    await page.keyboard.type("echo focused");
    await page.keyboard.press("Enter");
    await expect.poll(() => backend.ptyWrites(2)).toBe("echo focused\r");
    await expect.poll(() => backend.openPtyIds()).toEqual([1, 2]);
    await expect(diff).toBeVisible();

    await page.keyboard.press("Meta+w");
    await expect.poll(() => backend.openPtyIds()).toEqual([1]);
    await expect(diff).toBeVisible();
  });
}

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
  await expect(dialog.getByRole("heading", { name: "Appearance", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("heading", { name: "Default folder" })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Open config file" })).toBeInViewport();
  const advanced = dialog.getByRole("button", { name: "Advanced", exact: true });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  const about = dialog.getByRole("heading", { name: "About", exact: true });
  await expect(about).toBeHidden();

  await dialog.getByRole("button", { name: /Large text/ }).click();
  await expect(dialog.locator(".settings-preview-terminal")).toHaveCSS("font-size", "18px");
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  for (const label of ["More appearance options", "Terminal", "Connections & transfers", "CLI tools", "About"]) {
    const heading = dialog.getByRole("heading", { name: label, exact: true });
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toBeInViewport();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("SSH connect overlay opens and validates the form", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect SSH" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect SSH" });
  await expect(dialog).toBeVisible();

  const host = dialog.getByRole("textbox", { name: "SSH command or host" });
  const connect = dialog.getByRole("button", { name: "Connect", exact: true });
  const browse = dialog.getByRole("button", { name: "Browse ~/.ssh/config" });
  const advanced = dialog.getByRole("button", { name: "Advanced", exact: true });
  await expect(host).toBeFocused();
  await expect(dialog.getByRole("option", { name: /staging/ })).toBeVisible();
  await expect(connect).toBeDisabled();

  await expect(browse).toHaveAttribute("aria-expanded", "false");
  await browse.click();
  await expect(dialog.getByText("No additional hosts in ~/.ssh/config")).toBeVisible();
  await browse.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await advanced.click();
  await expect(dialog.getByLabel("Port", { exact: true })).toBeVisible();
  await advanced.click();

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

test("SSH startup command runs once on connect, split, duplicate and manual reconnect", async ({ page, backend }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect SSH" }).click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
  await dialog.locator("#ssh-connect-host").fill("deploy@example.test");
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  await dialog.locator("#ssh-post-connect-command").fill("echo startup-ready");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => backend.ptyWrites(1)).toBe("echo startup-ready\r");
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$ echo startup-ready");
  const [originalId] = await terminalSessionIds(page);

  // No exit/disconnect event: a seemingly live, stalled SSH terminal must
  // still offer a way to replace its transport, without adding a session.
  await page.locator(".xterm-helper-textarea").first().focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => backend.openPtyIds()).toEqual([2]);
  expect(await terminalSessionIds(page)).toEqual([originalId]);
  await expect.poll(() => backend.ptyWrites(2)).toBe("echo startup-ready\r");

  await page.keyboard.press("Meta+d");
  await expect.poll(() => backend.openPtyIds()).toEqual([2, 3]);
  await expect.poll(() => backend.ptyWrites(3)).toBe("echo startup-ready\r");

  const card = page.getByRole("button", { name: /Remote SSH session/ }).last();
  await card.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Reconnect", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "New window on this host", exact: true }).click();
  await expect.poll(() => backend.openPtyIds()).toEqual([2, 3, 4]);
  await expect.poll(() => backend.ptyWrites(4)).toBe("echo startup-ready\r");
  // Subsequent output/rerenders must not replay the already consumed input.
  await backend.emitPtyOutput(4, "\r\nindependent output\r\n");
  await expect(page.locator(".xterm-rows").last()).toContainText("independent output");
  expect(await backend.ptyWrites(2)).toBe("echo startup-ready\r");
  expect(await backend.ptyWrites(3)).toBe("echo startup-ready\r");
  expect(await backend.ptyWrites(4)).toBe("echo startup-ready\r");

  const panesBeforeReconnect = await terminalSessionIds(page);
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => backend.openPtyIds()).toEqual([2, 3, 5]);
  await expect.poll(() => backend.ptyWrites(5)).toBe("echo startup-ready\r");
  expect(await terminalSessionIds(page)).toEqual(panesBeforeReconnect);
  const opens = await page.evaluate(() => window.__TUNARA_E2E__!.state.calls
    .filter((call) => call.cmd === "ssh_open_v2")
    .map((call) => call.args?.request as { forceNewConnection: boolean; shareWithLogicalSessionId: string | null }));
  expect(opens.map((request) => request.forceNewConnection)).toEqual([false, true, false, false, true]);
  expect(opens[4].shareWithLogicalSessionId).not.toBeNull();
});

test("failed SSH banner clamps its message and keeps recovery actions together", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/");
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__ as typeof window.__TAURI_INTERNALS__ & {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
    };
    const invoke = internals.invoke.bind(internals);
    internals.invoke = (command, args) => {
      if (command === "ssh_open_v2") {
        return Promise.reject({
          diagnostic: {
            schemaVersion: 1,
            stage: "DNS",
            code: "dnsFailed",
            severity: "error",
            retryable: true,
            hopRole: "direct",
            timestamp: Date.now(),
          },
        });
      }
      return invoke(command, args);
    };
  });
  await page.getByRole("button", { name: "Connect SSH" }).click();

  const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
  await dialog.locator("#ssh-connect-host").fill("deploy@example.test");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();

  const message = page.locator('[role="alert"] span[title^="SSH connection failed"]');
  await expect(message).toBeVisible();
  await expect(message).toContainText("Couldn't resolve the host name. Check the address or your DNS/VPN.");
  await page.getByRole("button", { name: "Close inspector" }).click();
  const messageStyle = await message.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      lineClamp: style.webkitLineClamp,
      boxOrient: style.webkitBoxOrient,
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
    };
  });
  expect(["-webkit-box", "flow-root"]).toContain(messageStyle.display);
  expect(messageStyle.lineClamp).toBe("2");
  expect(messageStyle.boxOrient).toBe("vertical");
  expect(messageStyle.whiteSpace).toBe("normal");
  expect(messageStyle.overflow).toBe("hidden");

  const actionStyle = await page.getByRole("alert").getByRole("button").first().evaluate((button) => {
    const style = getComputedStyle(button.parentElement!);
    return { flexWrap: style.flexWrap, alignItems: style.alignItems };
  });
  expect(actionStyle).toEqual({ flexWrap: "nowrap", alignItems: "center" });

  await page.setViewportSize({ width: 820, height: 700 });
  const actionGroup = page.getByRole("alert").locator(".pane-recovery-bar__actions");
  const [messageBox, actionBox] = await Promise.all([message.boundingBox(), actionGroup.boundingBox()]);
  expect(messageBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThanOrEqual(messageBox!.y + messageBox!.height);
  const messageSize = await message.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(messageSize.scrollHeight).toBeLessThanOrEqual(messageSize.clientHeight + 1);
});
