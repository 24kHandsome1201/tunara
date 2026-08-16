import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SHELL_TINTS, LIGHT_THEME, DARK_THEME, isTerminalThemeDark, NAMED_DARK_TERMINAL_THEME_KEYS } from "../src/styles/terminalTheme.ts";
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

function oklchToHex([lightness, chroma, hue]) {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const toSrgb = (c) => Math.round(Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) * 255);
  return `#${linear.map((c) => toSrgb(c).toString(16).padStart(2, "0")).join("")}`;
}

test("default terminal canvases stay in sync with the shell paper tokens", () => {
  const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
  const darkBlock = css.slice(css.indexOf(".dark {"), css.indexOf(".hover-bg"));

  // The default terminal canvas is the main paper surface and the primary ink.
  // If the OKLCH tokens move, the hex palettes must move with them — otherwise
  // the WebGL canvas stops matching the surrounding chrome. See
  // docs/DEFAULT_TERMINAL_PALETTE.md.
  assert.equal(LIGHT_THEME.background, oklchToHex(parseOklch(lightBlock, "--c-bg-white")));
  assert.equal(LIGHT_THEME.foreground, oklchToHex(parseOklch(lightBlock, "--c-text-primary")));
  assert.equal(DARK_THEME.background, oklchToHex(parseOklch(darkBlock, "--c-bg-white")));
  assert.equal(DARK_THEME.foreground, oklchToHex(parseOklch(darkBlock, "--c-text-primary")));
});

test("info badge text stays AA on its background in both modes", () => {
  const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const lightBlock = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
  const darkBlock = css.slice(css.indexOf(".dark {"), css.indexOf(".hover-bg"));
  const readHex = (block, key) => {
    const match = block.match(new RegExp(`${key}:\\s*(#[0-9a-f]{6})`, "i"));
    assert.ok(match, `missing ${key}`);
    return match[1];
  };

  for (const [mode, block] of [["light", lightBlock], ["dark", darkBlock]]) {
    const ratio = contrastRatio(readHex(block, "--c-info"), readHex(block, "--c-info-bg"));
    assert.ok(ratio >= 4.5, `${mode} --c-info on --c-info-bg is ${ratio.toFixed(2)}:1`);
  }
});

test("default light and dark shell tokens keep text AA and control boundaries at 3:1", () => {
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

    const controlBorder = parseOklch(block, "--c-control-border");
    for (const surfaceKey of surfaceKeys) {
      const ratio = oklchContrast(controlBorder, parseOklch(block, surfaceKey));
      assert.ok(ratio >= 3, `${theme} --c-control-border is ${ratio.toFixed(2)}:1 on ${surfaceKey}`);
    }
  }
});

function mixHex(foreground, background, amount) {
  const channels = (hex) => hex.match(/[\da-f]{2}/gi).map((channel) => Number.parseInt(channel, 16));
  const front = channels(foreground);
  const back = channels(background);
  return `#${front.map((channel, index) => Math.round(channel * amount + back[index] * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
}

test("theme-aware primary controls stay AA for every accent and named palette", () => {
  const controls = readFileSync(new URL("../src/ui/overlays/settings/controls.tsx", import.meta.url), "utf8");
  const accentStart = controls.indexOf("export const ACCENT_COLORS");
  const accentBlock = controls.slice(accentStart, controls.indexOf("];", accentStart));
  const accents = [...accentBlock.matchAll(/color: "(#[\da-f]{6})"/gi)].map((match) => match[1]);
  assert.equal(accents.length, 8);
  for (const name of Object.keys(SHELL_TINTS)) {
    const dark = isTerminalThemeDark(name);
    const base = dark ? "#e4e4e7" : "#27272a";
    const text = dark ? "#18181b" : "#ffffff";
    for (const accent of accents) {
      for (const amount of [0.55, 0.60]) {
        const background = mixHex(accent, base, amount);
        assert.ok(contrastRatio(background, text) >= 4.5, `${name} ${accent} primary text is below 4.5:1`);
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
    "--c-control-border": "#ffffff",
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
