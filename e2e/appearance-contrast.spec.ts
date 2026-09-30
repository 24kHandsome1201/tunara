import { contrastRatio } from "../src/styles/shell-tint-contrast";
import { expect, openLocalTerminal, test } from "./fixtures";

test.use({ locale: "en-US" });

for (const theme of ["Light", "Dark"] as const) {
  test(`${theme} selected font toggles retain AA contrast after repeated toggles`, async ({ page, backend }) => {
    await openLocalTerminal(page, backend);
    await page.keyboard.press("Meta+,");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("radio", { name: theme, exact: true }).click();

    for (const name of ["Nerd Font", "Ligatures"]) {
      const button = dialog.getByRole("button", { name, exact: true });
      if (await button.getAttribute("aria-pressed") === "true") await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "false");

      for (let cycle = 0; cycle < 2; cycle += 1) {
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect.poll(async () => button.evaluate((element) => {
          const style = getComputedStyle(element);
          return style.color;
        })).toBe("rgb(24, 24, 27)");

        const colors = await button.evaluate((element) => {
          const style = getComputedStyle(element);
          // Canvas normalizes the browser's computed CSS colors to sRGB hex.
          const context = document.createElement("canvas").getContext("2d")!;
          context.fillStyle = style.color;
          const foreground = context.fillStyle;
          context.fillStyle = style.backgroundColor;
          return { foreground, background: context.fillStyle };
        });
        expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);

        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "false");
      }
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
}
