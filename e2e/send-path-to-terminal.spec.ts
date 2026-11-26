import type { Page } from "@playwright/test";
import type { DirEntry } from "../src/modules/fs/fs-bridge";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 1280, height: 620 } });

async function openFiles(page: Page, { ssh = false, controlName = false, startupCommand = "" } = {}) {
  await page.goto("/");
  await page.evaluate(({ controlName, startupCommand }) => {
    type MockInvoke = (command: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    const invoke = window.__TAURI_INTERNALS__.invoke as MockInvoke;
    const entry = (name: string, kind: DirEntry["kind"]): DirEntry => ({
      name, kind, size: 42, mtime: Date.UTC(2025, 2, 3, 12),
    });
    const invokeWithListing: MockInvoke = (command, args, options) => {
      if (startupCommand && command === "pty_write" && args?.data === startupCommand + "\r") {
        const pty = window.__TUNARA_E2E__?.state.ptys.find((pty) => pty.id === args.id);
        if (pty) pty.autoPrompt = false;
      }
      if (command === "fs_resolve_dir" && args?.path === "~") {
        return Promise.resolve("/home/e2e");
      }
      if (command === "fs_read_dir" || command === "ssh_fs_read_dir") {
        return Promise.resolve([
          entry("docs draft", "dir"),
          entry("src", "dir"),
          entry("tests", "dir"),
          entry("package.json", "file"),
          entry("README.md", "file"),
          ...(controlName ? [entry("bad\nname", "file")] : []),
        ]);
      }
      return invoke(command, args, options);
    };
    window.__TAURI_INTERNALS__.invoke = invokeWithListing;
  }, { controlName, startupCommand });
  if (ssh) {
    await page.getByRole("button", { name: "Connect SSH" }).click();
    const dialog = page.locator('[role="dialog"][aria-labelledby="ssh-connect-title"]');
    await dialog.locator("#ssh-connect-host").fill("deploy@example.test");
    if (startupCommand) {
      await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
      await dialog.locator("#ssh-post-connect-command").fill(startupCommand);
    }
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Local terminal" }).click();
  }
  const terminal = page.locator(".xterm-rows").first();
  await expect(terminal).toContainText("e2e$");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible();
  return terminal;
}

for (const { kind, name, expected } of [
  { kind: "folder", name: "docs draft", expected: "cd -- '/home/e2e/docs draft'" },
  { kind: "file", name: "README.md", expected: "'/home/e2e/README.md'" },
]) {
  test(`row action inserts the ${kind} path into the current prompt without Enter`, async ({ page, backend }) => {
    const terminal = await openFiles(page);
    const row = page.getByRole("treeitem", { name, exact: true });
    await row.hover();
    await row.getByRole("button", { name: `Send path to terminal: ${name}` }).click();
    await expect(terminal).toContainText(`e2e$ ${expected}`);
    await expect.poll(() => backend.ptyWrites(1)).toBe(expected);
    await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(page.getByRole("tabpanel", { name: "Files" })).toBeVisible();
    await expect.poll(() => backend.openPtyIds()).toEqual([1]);
    if (kind === "folder") await expect(row).toHaveAttribute("aria-expanded", "false");
    const capture = process.env.SEND_PATH_CAPTURE;
    if (capture) await page.screenshot({ path: `${capture}-${kind}.png`, animations: "disabled" });

    await page.keyboard.press("Enter");
    await expect.poll(() => backend.ptyWrites(1)).toBe(`${expected}\r`);

    await row.getByRole("button", { name: `More actions: ${name}` }).click();
    await expect(page.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
    await expect(page.getByRole("menuitem", {
      name: kind === "folder" ? "New terminal in this directory" : "Open in terminal",
    })).toBeVisible();
  });
}

test("SSH sends the path through the bound prompt, not a running command", async ({ page, backend }) => {
  const terminal = await openFiles(page, { ssh: true });
  const file = page.getByRole("treeitem", { name: "README.md", exact: true });
  const send = file.getByRole("button", { name: "Send path to terminal: README.md" });

  await backend.emitPtyOutput(1, "\x1b]133;C;sleep%2060\x07\r\nRunning a command");
  await expect(terminal).toContainText("Running a command");
  await file.hover();
  await send.click();
  await expect(page.getByText("Start at a fresh prompt with shell integration enabled, or use Copy path.")).toBeVisible();
  expect(await backend.ptyWrites(1)).toBe("");

  await backend.emitPtyOutput(1, "\r\n\x1b]133;D;0\x07\x1b]133;A\x07ssh$ \x1b]133;B\x07");
  await expect(terminal).toContainText("ssh$");
  await file.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Send path to terminal" }).click();
  await expect(terminal).toContainText("ssh$ '/home/e2e/README.md'");
  expect(await backend.ptyWrites(1)).toBe("'/home/e2e/README.md'");
  await expect.poll(() => backend.openPtyIds()).toEqual([1]);
});

test("a path containing a newline is never written into a live prompt", async ({ page, backend }) => {
  await openFiles(page, { controlName: true });
  const file = page.getByRole("treeitem", { name: "bad name", exact: true });
  await file.hover();
  await file.getByRole("button", { name: "Send path to terminal: bad name" }).click();
  await expect(page.getByText("This path is not absolute or contains unsupported control characters.")).toBeVisible();
  expect(await backend.ptyWrites(1)).toBe("");
});

test("SSH startup command invalidates an older shell's prompt without a command-start marker", async ({ page, backend }) => {
  const terminal = await openFiles(page, { ssh: true, startupCommand: "sleep 60" });
  await expect.poll(() => backend.ptyWrites(1)).toBe("sleep 60\r");
  await expect(terminal).toContainText("e2e$ sleep 60");
  const file = page.getByRole("treeitem", { name: "README.md", exact: true });
  await file.hover();
  await file.getByRole("button", { name: "Send path to terminal: README.md" }).click();
  await expect(page.getByText("Could not send path to terminal")).toBeVisible();
  expect(await backend.ptyWrites(1)).toBe("sleep 60\r");
});

for (const { label, input } of [
  { label: "unfinished quote", input: 'echo "' },
  { label: "command without a separator", input: "cat" },
]) {
  test(`file path insertion waits for a fresh prompt after typing: ${label}`, async ({ page, backend }) => {
    const terminal = await openFiles(page);
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(input);
    await expect(terminal).toContainText(`e2e$ ${input}`);
    const file = page.getByRole("treeitem", { name: "README.md", exact: true });
    const send = file.getByRole("button", { name: "Send path to terminal: README.md" });
    await file.hover();
    await send.click();
    await expect(page.getByText("Could not send path to terminal")).toBeVisible();
    expect(await backend.ptyWrites(1)).toBe(input);

    await backend.emitPtyOutput(1, "\r\n\x1b]133;A\x07delayed$ \x1b]133;B\x07");
    await expect(terminal).toContainText("delayed$");
    await send.click();
    expect(await backend.ptyWrites(1)).toBe(input);

    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await expect.poll(() => backend.ptyWrites(1)).toBe(input + "\x03");
    await backend.emitPtyOutput(1, "\r\n\x1b]133;A\x07fresh$ \x1b]133;B\x07");
    await expect(terminal).toContainText("fresh$");
    await send.click();
    await expect(terminal).toContainText("fresh$ '/home/e2e/README.md'");
    expect(await backend.ptyWrites(1)).toBe(input + "\x03'/home/e2e/README.md'");
  });
}
