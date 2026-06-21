import { useEffect } from "react";
import { useUIStore } from "@/state/ui";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function mixColor(fg: [number, number, number], bg: [number, number, number], alpha: number): string {
  return rgbToHex(
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  );
}

function deriveAccentVars(accent: string, dark: boolean) {
  const rgb = hexToRgb(accent);
  const base: [number, number, number] = dark ? [24, 24, 27] : [255, 255, 255];
  return {
    "--c-accent-bg-light": mixColor(rgb, base, dark ? 0.18 : 0.12),
    "--c-accent-bg-soft": mixColor(rgb, base, dark ? 0.10 : 0.06),
    "--c-accent-border": mixColor(rgb, base, dark ? 0.30 : 0.22),
    "--c-accent-selection": accent + (dark ? "66" : "44"),
  };
}

export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);

  useEffect(() => {
    const root = document.documentElement;

    const apply = (dark: boolean) => {
      root.classList.toggle("dark", dark);
      root.style.setProperty("--c-accent", accent);
      const vars = deriveAccentVars(accent, dark);
      for (const [k, v] of Object.entries(vars)) {
        root.style.setProperty(k, v);
      }
    };

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      apply(mq.matches);
      const on = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    }
    apply(theme === "dark");
  }, [theme, accent]);
}
