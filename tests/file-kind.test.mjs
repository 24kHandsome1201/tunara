import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FILE_KIND_FAMILIES,
  fileKindFamily,
  fileKindTint,
  isNumericTableColumn,
} from "../src/ui/file-explorer/file-kind.ts";

function parseOklch(block, key) {
  const match = block.match(new RegExp(`${key}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
  assert.ok(match, `missing OKLCH token ${key}`);
  return [Number(match[1]) / 100, Number(match[2]), Number(match[3])];
}

function oklchLuminance([lightness, chroma, hue]) {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const linearRgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.max(0, Math.min(1, channel)));
  return 0.2126 * linearRgb[0] + 0.7152 * linearRgb[1] + 0.0722 * linearRgb[2];
}

function oklchContrast(first, second) {
  const firstLuminance = oklchLuminance(first);
  const secondLuminance = oklchLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

test("fileKindFamily maps extension and special names onto the seven families", () => {
  assert.equal(fileKindFamily("src/index.ts"), "code");
  assert.equal(fileKindFamily("App.tsx"), "code");
  assert.equal(fileKindFamily("users.json"), "data");
  assert.equal(fileKindFamily("dump.csv"), "data");
  assert.equal(fileKindFamily("notes.yaml"), "data");
  assert.equal(fileKindFamily("Cargo.toml"), "data");
  assert.equal(fileKindFamily("README.md"), "doc");
  assert.equal(fileKindFamily("notes.txt"), "doc");
  assert.equal(fileKindFamily("manual.pdf"), "doc");
  assert.equal(fileKindFamily("photo.png"), "image");
  assert.equal(fileKindFamily(".gitignore"), "config");
  assert.equal(fileKindFamily(".env.local"), "config");
  assert.equal(fileKindFamily("pnpm-lock.yaml"), "config");
  assert.equal(fileKindFamily("Cargo.lock"), "config");
  assert.equal(fileKindFamily("Dockerfile"), "config");
  assert.equal(fileKindFamily("setup.py"), "script");
  assert.equal(fileKindFamily("bootstrap.sh"), "script");
  assert.equal(fileKindFamily("analysis.ipynb"), "script");
  assert.equal(fileKindFamily("server.log"), "log");
  assert.equal(fileKindFamily("unknown.bin"), null);
  assert.equal(fileKindFamily("Makefile"), "config");
});

test("fileKindTint is an icon CSS variable and never a filename color", () => {
  assert.equal(fileKindTint("index.ts"), "var(--c-file-code)");
  assert.equal(fileKindTint("mystery"), undefined);
  assert.deepEqual(
    FILE_KIND_FAMILIES.map((family) => `var(--c-file-${family})`),
    [
      "var(--c-file-code)",
      "var(--c-file-data)",
      "var(--c-file-doc)",
      "var(--c-file-image)",
      "var(--c-file-config)",
      "var(--c-file-script)",
      "var(--c-file-log)",
    ],
  );
});

test("isNumericTableColumn requires every non-empty cell in the column to be numeric", () => {
  const rows = [
    ["alpha", "1", ""],
    ["beta", "2.5", "x"],
    ["gamma", "3e2", ""],
  ];
  assert.equal(isNumericTableColumn(rows, 0), false);
  assert.equal(isNumericTableColumn(rows, 1), true);
  assert.equal(isNumericTableColumn(rows, 2), false);
  assert.equal(isNumericTableColumn([["", ""]], 0), false);
});

test("files.css is imported from main.tsx immediately after globals.css", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /import "\.\/styles\/globals\.css";\nimport "\.\/styles\/files\.css";/);
});

test("file-kind tokens stay calm and AA against both theme surfaces", () => {
  const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
  const darkBlock = css.slice(css.indexOf(".dark {"), css.indexOf(".hover-bg"));
  const surfaceKeys = ["--c-bg-white", "--c-bg-1", "--c-bg-2", "--c-bg-3", "--c-bg-hover"];

  for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
    for (const family of FILE_KIND_FAMILIES) {
      const color = parseOklch(block, `--c-file-${family}`);
      assert.ok(color[1] <= 0.08, `${theme} --c-file-${family} chroma ${color[1]} exceeds 0.08`);
      for (const surfaceKey of surfaceKeys) {
        const ratio = oklchContrast(color, parseOklch(block, surfaceKey));
        assert.ok(
          ratio >= 4.5,
          `${theme} --c-file-${family} is ${ratio.toFixed(2)}:1 on ${surfaceKey}`,
        );
      }
    }
  }
});
