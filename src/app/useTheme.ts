import { useEffect } from "react";
import { useUIStore } from "@/state/ui";
import { applyBootShellTint } from "@/styles/shell-tint-boot";

export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const terminalTheme = useUIStore((s) => s.terminalTheme);

  useEffect(() => {
    const root = document.documentElement;

    const apply = (systemDark: boolean) => {
      applyBootShellTint(root, terminalTheme, theme, accent, systemDark);
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