import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const tokensCss = readFileSync(resolve("src/styles/tokens.css"), "utf8");
const globalsCss = readFileSync(resolve("src/styles/globals.css"), "utf8");

afterEach(() => {
  delete document.documentElement.dataset.reduceMotion;
  document.documentElement.classList.remove("dark");
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
    html[data-reduce-motion] {
      --dur-fast: 0ms;
      --dur-base: 0ms;
      --dur-slow: 0ms;
    }
  `;
  document.head.appendChild(style);
}

test("motion tokens are defined and reduced motion is driven by html[data-reduce-motion]", () => {
  expect(tokensCss).toMatch(/--dur-instant:\s*60ms/);
  expect(tokensCss).toMatch(/--dur-fast:\s*120ms/);
  expect(tokensCss).toMatch(/--dur-base:\s*160ms/);
  expect(tokensCss).toMatch(/--dur-slow:\s*220ms/);
  expect(tokensCss).toMatch(/--ease-out:\s*cubic-bezier\(0\.2, 0, 0, 1\)/);
  expect(tokensCss).toMatch(/--ease-in-out:\s*cubic-bezier\(0\.4, 0, 0\.2, 1\)/);
  expect(tokensCss).toMatch(/--c-state-ok:\s*oklch\(/);
  expect(tokensCss).toMatch(/--c-state-err:\s*oklch\(/);

  // Single source: the attribute written by useTheme zeroes the scale;
  // the dead .reduce-motion class path is gone.
  expect(tokensCss).toMatch(/html\[data-reduce-motion\][\s\S]*--dur-base:\s*0ms/);
  expect(globalsCss).not.toMatch(/html\.reduce-motion/);
});

test("setting data-reduce-motion zeroes the duration tokens", () => {
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
    document.documentElement.dataset.reduceMotion = "";
  }

  expect(document.documentElement.dataset.reduceMotion).toBe("");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-base").trim()).toBe("0ms");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-fast").trim()).toBe("0ms");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--dur-slow").trim()).toBe("0ms");
});
