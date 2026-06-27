import { useEffect } from "react";
import { useUIStore } from "@/state/ui";
import { SHELL_TINTS, SHELL_TINT_KEYS, isTerminalThemeDark } from "@/styles/terminalTheme";

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
  const terminalTheme = useUIStore((s) => s.terminalTheme);

  useEffect(() => {
    const root = document.documentElement;
    const tint = terminalTheme !== "default" ? SHELL_TINTS[terminalTheme] : undefined;

    // 顺序：清旧壳 → 定明暗 → 染壳 → 盖强调（强调始终最后，与外壳正交叠加）。
    const apply = (systemDark: boolean) => {
      // 1) 清掉上一次染的壳变量，让 default 回落到 tokens.css 的 :root/.dark。
      for (const key of SHELL_TINT_KEYS) root.style.removeProperty(key);

      // 2) 明暗类：有暗色预设时预设说了算，否则跟随 app theme。
      //    暗色预设 + 亮色 app theme 也必须开 .dark，否则未染的语义色（agent/diff）用亮版，与暗壳打架。
      const dark = terminalTheme !== "default" ? isTerminalThemeDark(terminalTheme, theme) : systemDark;
      root.classList.toggle("dark", dark);

      // 3) 染壳：写入该预设的 UI 槽位，盖住 tokens.css。
      if (tint) for (const [k, v] of Object.entries(tint)) root.style.setProperty(k, v);

      // 4) 强调色派生变量最后注入，不被染壳覆盖。
      root.style.setProperty("--c-accent", accent);
      const vars = deriveAccentVars(accent, dark);
      for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    };

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      apply(mq.matches);
      const on = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    }
    apply(theme === "dark");
  }, [theme, accent, terminalTheme]);
}
