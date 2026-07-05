import assert from "node:assert/strict";
import test from "node:test";

import { SHELL_TINTS } from "../src/styles/terminalTheme.ts";
import {
  assertShellTintContrast,
  contrastRatio,
} from "../src/styles/shell-tint-contrast.ts";
import {
  BOOT_APPEARANCE_STORAGE_KEY,
  applyBootShellTint,
  persistBootAppearance,
  readBootAppearance,
} from "../src/styles/shell-tint-boot.ts";

test("contrastRatio computes WCAG relative luminance for hex pairs", () => {
  assert.ok(contrastRatio("#000000", "#ffffff") > 20);
  assert.ok(contrastRatio("#ffffff", "#ffffff") === 1);
  assert.ok(contrastRatio("#cdd6f4", "#1e1e2e") >= 4.5);
});

test("assertShellTintContrast passes for every shell tint preset", () => {
  assert.doesNotThrow(() => assertShellTintContrast(SHELL_TINTS));
});

test("assertShellTintContrast rejects presets below the AA threshold", () => {
  assert.throws(
    () =>
      assertShellTintContrast({
        bad: {
          "--c-bg-1": "#002b36",
          "--c-text-primary": "#002b36",
        },
      }),
    /below 4\.5:1/,
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