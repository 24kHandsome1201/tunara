import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const listFiles = (dir, exts) =>
  readdirSync(resolve(root, dir), { recursive: true })
    .map((entry) => join(dir, entry.toString()))
    .filter((path) => exts.some((ext) => path.endsWith(ext)) && statSync(resolve(root, path)).isFile());

const tokensCss = read("src/styles/tokens.css");
const globalsCss = read("src/styles/globals.css");
const useTheme = read("src/app/useTheme.ts");

// Canonical scales from docs/DESIGN_SYSTEM.md; keeping the names here makes
// renaming or dropping a token a deliberate contract change.
const REQUIRED_TOKENS = [
  "--h-btn-sm", "--h-btn-md", "--h-btn-lg",
  "--h-control", "--h-control-sm",
  "--icon-xs", "--icon-sm", "--icon-md",
  "--dot-sm", "--dot-md",
  "--r-menu",
  "--z-raised", "--z-sticky", "--z-shell", "--z-overlay",
  "--z-palette", "--z-toast", "--z-menu", "--z-system",
  "--dur-instant", "--dur-fast", "--dur-base", "--dur-slow", "--dur-loading",
  "--delay-loading-fallback", "--dur-toast", "--dur-toast-long",
  "--ease-out", "--ease-in-out",
  "--motion-distance-sm", "--motion-distance-md", "--motion-distance-lg",
  "--motion-scale-in", "--press-scale", "--press-scale-icon",
  "--focus-ring-w", "--focus-ring-offset", "--focus-ring-color", "--focus-ring-soft",
];

test("tokens.css defines the canonical size/z-index/motion/focus scale", () => {
  for (const token of REQUIRED_TOKENS) {
    assert.match(tokensCss, new RegExp(`${token.replaceAll("-", "\\-")}\\s*:`), `missing token ${token}`);
  }
});

test("retired alias tokens are gone from definitions and usages", () => {
  const retired = /--(?:duration-(?:fast|normal|slow|expand)|ease-out-expo|ease-out-back|ease-smooth|scale-press)\b/;
  const sources = [...listFiles("src", [".ts", ".tsx", ".css"]), "docs/DESIGN_SYSTEM.md"].map((path) => [path, read(path)]);
  for (const [path, text] of sources) {
    assert.doesNotMatch(text, retired, `${path} still references a retired motion token`);
  }
});

test("no literal ms/s durations outside tokens.css", () => {
  // Temporary allowlist: the attentionBreathe literal is removed by the
  // bug-fix PR that owns those lines; drop this once it lands.
  const allow = new Set(["attentionBreathe 2.4s"]);
  const literal = /\d+(?:\.\d+)?\s*m?s\b/g;
  for (const path of listFiles("src", [".css", ".tsx", ".ts"])) {
    if (path.endsWith("tokens.css")) continue;
    const text = read(path);
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(literal)) {
        const needle = match[0];
        const context = line.trim();
        if ([...allow].some((ok) => context.includes(ok))) continue;
        // Duration units only matter in motion contexts; skip unrelated hits
        // such as "0ms" constants in test fixtures or comments about timing.
        if (!/transition|animation|duration|delay/i.test(context)) continue;
        assert.fail(`${path}:${index + 1} has a literal duration "${needle}" — use a --dur-*/--delay-* token`);
      }
    });
  }
});

test("global z-index layers resolve through --z-* tokens", () => {
  // Intra-component stacking (|z| < 10) is fine; anything at or above the
  // --z-raised layer must come from the token scale so the order stays
  // documented in one place.
  const zIndex = /z-?[iI]ndex\s*:\s*(-?\d+)/g;
  for (const path of listFiles("src", [".css", ".tsx", ".ts"])) {
    if (path.endsWith("tokens.css")) continue;
    const text = read(path);
    for (const match of text.matchAll(zIndex)) {
      const value = Number.parseInt(match[1], 10);
      assert.ok(
        Math.abs(value) < 10,
        `${path} uses numeric z-index ${value} — use a --z-* token`,
      );
    }
  }
});

test("reduced motion has a single source: useTheme drives html[data-reduce-motion]", () => {
  assert.match(useTheme, /prefers-reduced-motion: reduce/);
  assert.match(useTheme, /dataset\.reduceMotion/);
  assert.match(tokensCss, /html\[data-reduce-motion\]/);
  assert.doesNotMatch(globalsCss, /html\.reduce-motion/);
  assert.doesNotMatch(globalsCss, /@media \(prefers-reduced-motion/);
});
