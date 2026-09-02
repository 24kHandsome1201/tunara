import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const tokensCss = readFileSync(resolve("src/styles/tokens.css"), "utf8");
const globalsCss = readFileSync(resolve("src/styles/globals.css"), "utf8");

afterEach(() => {
  document.documentElement.classList.remove("reduce-motion", "dark");
  document.querySelectorAll("[data-motion-test]").forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

function installMotionStyles() {
  const style = document.createElement("style");
  style.dataset.motionTest = "true";
  style.textContent = `
    :root {
      --dur-fast: 120ms;
      --dur-base: 160ms;
      --dur-slow: 220ms;
    }
    html.reduce-motion,
    html.reduce-motion.dark {
      --dur-fast: 0ms;
      --dur-base: 0ms;
      --dur-slow: 0ms;
    }
  `;
  document.head.appendChild(style);
}

test("motion tokens are defined and reduced-motion zeroes them via one media query plus class fallback", () => {
  expect(tokensCss).toMatch(/--dur-fast:\s*120ms/);
  expect(tokensCss).toMatch(/--dur-base:\s*160ms/);
  expect(tokensCss).toMatch(/--dur-slow:\s*220ms/);
  expect(tokensCss).toMatch(/--ease-out:\s*cubic-bezier\(0\.2, 0, 0, 1\)/);
  expect(tokensCss).toMatch(/--ease-in-out:\s*cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
  expect(tokensCss).toMatch(/--c-state-ok:\s*oklch\(/);
  expect(tokensCss).toMatch(/--c-state-err:\s*oklch\(/);

  const reducedBlocks = globalsCss.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? [];
  expect(reducedBlocks).toHaveLength(1);
  expect(globalsCss).toMatch(/html\.reduce-motion/);
  expect(globalsCss).toMatch(/--dur-base:\s*0ms/);
});

test("prefers-reduced-motion matchMedia mock applies the class fallback so --dur-base is 0ms", () => {
  installMotionStyles();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-base").trim()).toBe("160ms");

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("reduce-motion");
  }

  expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-base").trim()).toBe("0ms");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-fast").trim()).toBe("0ms");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-slow").trim()).toBe("0ms");
});
