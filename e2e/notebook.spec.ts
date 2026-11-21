import { expect, test } from "./fixtures";

test.use({ locale: "en-US" });

test("notebook error and stream outputs render without ANSI escapes", async ({ page, backend }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const content = JSON.stringify({
      nbformat: 4,
      metadata: { kernelspec: { display_name: "Python 3" } },
      cells: [{
        cell_type: "code", execution_count: 1, source: "1 / 0",
        outputs: [
          { output_type: "stream", name: "stdout", text: "\u001b[32mRunning calculation…\u001b[0m\n" },
          {
            output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero",
            traceback: [
              "\u001b[0;31m---------------------------------------------------------------------------\u001b[0m",
              "\u001b[0;31mZeroDivisionError\u001b[0m                         Traceback (most recent call last)",
              "\u001b[0;32mCell In[1], line 1\u001b[0m\n\u001b[0;32m----> 1\u001b[0m 1 / 0",
              "\u001b[0;31mZeroDivisionError\u001b[0m: division by zero",
            ],
          },
        ],
      }, {
        cell_type: "code", execution_count: 2, source: "raise ValueError('bad value')",
        outputs: [{ output_type: "error", ename: "\u001b[31mValueError\u001b[0m", evalue: "\u001b[31mbad value\u001b[0m" }],
      }],
    });
    const original = window.__TAURI_INTERNALS__.invoke as (cmd: string, args?: unknown) => Promise<unknown>;
    window.__TAURI_INTERNALS__.invoke = (cmd: string, args?: unknown) => {
      if (cmd === "fs_resolve_dir") return Promise.resolve("/home/e2e");
      if (cmd === "fs_read_dir") return Promise.resolve([{ name: "error.ipynb", kind: "file", size: content.length, mtime: 0 }]);
      if (cmd === "fs_read_file") return Promise.resolve({ kind: "text", content, size: content.length });
      return original(cmd, args);
    };
  });
  await page.getByRole("button", { name: "Local terminal", exact: true }).click();
  await expect.poll(() => backend.openPtyIds()).toEqual([1]);
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "error.ipynb", exact: true }).click();
  const cell = page.getByRole("article", { name: "Code cell 1", exact: true });
  await expect(cell).toBeVisible();
  await expect(cell).toContainText("division by zero");
  if (process.env.NOTEBOOK_SCREENSHOT) {
    await page.evaluate(() => document.fonts.ready);
    await cell.screenshot({ path: process.env.NOTEBOOK_SCREENSHOT, animations: "disabled" });
  }
  await expect(cell.locator(".notebook-output").first()).toHaveText("Running calculation…\n");
  await expect(cell.locator(".notebook-output-error")).toHaveText(
    "---------------------------------------------------------------------------\nZeroDivisionError                         Traceback (most recent call last)\nCell In[1], line 1\n----> 1 1 / 0\nZeroDivisionError: division by zero",
  );
  await expect(page.getByRole("article", { name: "Code cell 2", exact: true }).locator(".notebook-output-error")).toHaveText("ValueError: bad value");
});
