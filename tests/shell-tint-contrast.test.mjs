import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SHELL_TINTS, isTerminalThemeDark, NAMED_DARK_TERMINAL_THEME_KEYS } from "../src/styles/terminalTheme.ts";
import {
  assertShellTintContrast,
  contrastRatio,
} from "../src/styles/shell-tint-contrast.ts";
import {
  BOOT_APPEARANCE_STORAGE_KEY,
  NAMED_DARK_TERMINAL_THEMES,
  applyBootShellTint,
  persistBootAppearance,
  readBootAppearance,
} from "../src/styles/shell-tint-boot.ts";

test("contrastRatio computes WCAG relative luminance for hex pairs", () => {
  assert.ok(contrastRatio("#000000", "#ffffff") > 20);
  assert.ok(contrastRatio("#ffffff", "#ffffff") === 1);
  assert.ok(contrastRatio("#cdd6f4", "#1e1e2e") >= 4.5);
});

test("every shell tint keeps all text levels AA and control borders at 3:1 on every surface", () => {
  assert.doesNotThrow(() => assertShellTintContrast(SHELL_TINTS));
});

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

test("default light and dark shell tokens keep every text level AA on every surface", () => {
  const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
  const darkBlock = css.slice(css.indexOf(".dark {"), css.indexOf(".hover-bg"));
  const textKeys = ["--c-text-primary", "--c-text-2", "--c-text-3", "--c-text-4", "--c-text-5", "--c-text-6", "--c-text-7"];
  const surfaceKeys = ["--c-bg-white", "--c-bg-1", "--c-bg-2", "--c-bg-3", "--c-bg-hover"];

  for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
    for (const textKey of textKeys) {
      for (const surfaceKey of surfaceKeys) {
        const ratio = oklchContrast(parseOklch(block, textKey), parseOklch(block, surfaceKey));
        assert.ok(ratio >= 4.5, `${theme} ${textKey} is ${ratio.toFixed(2)}:1 on ${surfaceKey}`);
      }
    }
  }
});

test("assertShellTintContrast rejects presets below the AA threshold", () => {
  const dark = {
    "--c-bg-white": "#002b36",
    "--c-bg-1": "#002b36",
    "--c-bg-2": "#002b36",
    "--c-bg-3": "#002b36",
    "--c-bg-hover": "#002b36",
    "--c-border-2": "#ffffff",
    "--c-text-primary": "#ffffff",
    "--c-text-2": "#ffffff",
    "--c-text-3": "#ffffff",
    "--c-text-4": "#ffffff",
    "--c-text-5": "#ffffff",
    "--c-text-6": "#ffffff",
    "--c-text-7": "#002b36",
  };
  assert.throws(
    () => assertShellTintContrast({ bad: dark }),
    /--c-text-7 contrast .* below 4\.5:1/,
  );
});

test("assertShellTintContrast rejects an indistinguishable control border", () => {
  assert.throws(
    () => assertShellTintContrast({
      bad: {
        ...SHELL_TINTS["one-dark"],
        "--c-border-2": SHELL_TINTS["one-dark"]["--c-bg-1"],
      },
    }),
    /--c-border-2 contrast .* below 3:1/,
  );
});

test("boot appearance helpers round-trip through localStorage", () => {
  const storage = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  };

  try {
    persistBootAppearance({
      theme: "dark",
      terminalTheme: "catppuccin",
      accent: "#c2683c",
    });
    assert.equal(storage.get(BOOT_APPEARANCE_STORAGE_KEY), JSON.stringify({
      theme: "dark",
      terminalTheme: "catppuccin",
      accent: "#c2683c",
    }));
    assert.deepEqual(readBootAppearance(), {
      theme: "dark",
      terminalTheme: "catppuccin",
      accent: "#c2683c",
    });
  } finally {
    globalThis.localStorage = original;
  }
});

test("applyBootShellTint writes shell tint variables on a stub root", () => {
  const props = new Map();
  const root = {
    classList: {
      dark: false,
      toggle(_cls, on) {
        this.dark = on;
      },
    },
    style: {
      removeProperty(key) {
        props.delete(key);
      },
      setProperty(key, value) {
        props.set(key, value);
      },
    },
  };

  applyBootShellTint(root, "catppuccin", "light", "#c2683c", false);

  assert.equal(root.classList.dark, true);
  assert.equal(props.get("--c-bg-1"), SHELL_TINTS.catppuccin["--c-bg-1"]);
  assert.equal(props.get("--c-text-primary"), SHELL_TINTS.catppuccin["--c-text-primary"]);
  assert.equal(props.get("--c-accent"), "#c2683c");
});

test("boot dark-theme key list stays in sync with isTerminalThemeDark", () => {
  // The cold-start boot script and the runtime must agree on which terminal
  // presets force the .dark class. If they diverge, cold start flashes the
  // wrong shell color until React hydrates.
  assert.deepEqual(
    [...NAMED_DARK_TERMINAL_THEMES].sort(),
    [...NAMED_DARK_TERMINAL_THEME_KEYS].sort(),
  );

  for (const key of NAMED_DARK_TERMINAL_THEMES) {
    assert.equal(
      isTerminalThemeDark(key, "light"),
      true,
      `${key} should be dark regardless of app theme`,
    );
  }
  // Light presets must not appear in the dark list.
  for (const key of Object.keys(SHELL_TINTS)) {
    if (!NAMED_DARK_TERMINAL_THEMES.includes(key)) {
      assert.equal(
        isTerminalThemeDark(key, "light"),
        false,
        `${key} should not be dark under a light app theme`,
      );
    }
  }
});
