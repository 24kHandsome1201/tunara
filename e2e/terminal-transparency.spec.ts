import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const xtermLib = dirname(require.resolve("@xterm/xterm"));
const webglLib = dirname(require.resolve("@xterm/addon-webgl"));

test.use({ launchOptions: { args: ["--enable-unsafe-swiftshader"] } });

async function loadXterm(page: Page) {
  await page.route("**/xterm-test/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (name === "xterm.mjs" || name === "addon-webgl.mjs") {
      await route.fulfill({
        path: join(name === "xterm.mjs" ? xtermLib : webglLib, name),
        contentType: "text/javascript",
      });
    } else {
      await route.fulfill({ contentType: "text/html", body: '<div id="terminal"></div>' });
    }
  });
  await page.goto("/xterm-test/");
  await page.addStyleTag({ path: join(xtermLib, "../css/xterm.css") });
}

test("GPU leaves italic cells transparent and preserves anti-aliased glyph coverage", async ({ page }) => {
  await loadXterm(page);
  const pixels = await page.evaluate(async () => {
    const xterm = "/xterm-test/xterm.mjs";
    const webgl = "/xterm-test/addon-webgl.mjs";
    const { Terminal } = await import(xterm) as typeof import("@xterm/xterm");
    const { WebglAddon } = await import(webgl) as typeof import("@xterm/addon-webgl");
    const terminal = new Terminal({
      cols: 12, rows: 3, fontSize: 16, cursorInactiveStyle: "none",
      allowTransparency: true, theme: { background: "#fdfcfb00" },
    });
    try {
      terminal.open(document.getElementById("terminal")!);
      terminal.loadAddon(new WebglAddon(true));
      async function writeAndPaint(text: string) {
        await new Promise<void>((done) => terminal.write(text, done));
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      }
      await writeAndPaint("\x1b[3m   \x1b[0m\r\n\x1b[48;2;0;255;0m   \x1b[0m\r\n\x1b[38;2;255;0;0mM\x1b[0m");
      const gl = Array.from(document.querySelectorAll("canvas"))
        .map((canvas) => canvas.getContext("webgl2"))
        .find((context) => context?.getContextAttributes()?.preserveDrawingBuffer);
      if (!gl) throw new Error("xterm WebGL drawing buffer is unavailable");
      const pixel = new Uint8Array(4);
      function sample(row: number) {
        gl!.readPixels(1, Math.floor(gl!.drawingBufferHeight * (1 - (row + 0.5) / 3)), 1, 1, gl!.RGBA, gl!.UNSIGNED_BYTE, pixel);
        return [...pixel];
      }
      const glyphHeight = Math.floor(gl.drawingBufferHeight / 3);
      const glyphWidth = Math.floor(gl.drawingBufferWidth / 12);
      const glyph = new Uint8Array(glyphWidth * glyphHeight * 4);
      gl.readPixels(0, 0, glyphWidth, glyphHeight, gl.RGBA, gl.UNSIGNED_BYTE, glyph);
      const edges = [];
      for (let i = 0; i < glyph.length; i += 4) {
        if (glyph[i] > 30 && glyph[i] < 225) edges.push(Math.abs(glyph[i] - glyph[i + 3]));
      }
      const italic = sample(0);
      const explicit = sample(1);
      await writeAndPaint("\x1b[2J");
      return { italic, explicit, edges, erased: sample(1) };
    } finally {
      terminal.dispose();
    }
  });
  expect.soft(pixels.italic, "foreground-only italic cells have no background").toEqual([0, 0, 0, 0]);
  expect(pixels.explicit, "an explicit ANSI background stays opaque").toEqual([0, 255, 0, 255]);
  expect(pixels.edges.length, "the red glyph has anti-aliased edge pixels").toBeGreaterThan(0);
  expect(Math.max(...pixels.edges), "premultiplied red edge pixels match their alpha").toBeLessThanOrEqual(2);
  expect(pixels.erased, "erasing the colored cell restores transparency").toEqual([0, 0, 0, 0]);
});

test("Compatibility keeps default inverse-video text readable in the light palette", async ({ page }) => {
  await loadXterm(page);
  await page.evaluate(async () => {
    const xterm = "/xterm-test/xterm.mjs";
    const { Terminal } = await import(xterm) as typeof import("@xterm/xterm");
    const terminal = new Terminal({
      minimumContrastRatio: 3, allowTransparency: true,
      theme: { background: "#fdfcfb00", foreground: "#241e1a" },
    });
    terminal.open(document.getElementById("terminal")!);
    terminal.write("\x1b[7mInverse\x1b[0m");
  });
  const cell = page.locator(".xterm-rows span").getByText("Inverse", { exact: true });
  await expect(cell).toHaveCSS("background-color", "rgb(36, 30, 26)");
  await expect(cell).toHaveCSS("color", "rgb(253, 252, 251)");
});
