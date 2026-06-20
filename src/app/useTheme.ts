import { useEffect } from "react";
import { useUIStore } from "@/state/ui";

export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);

  useEffect(() => {
    const root = document.documentElement;
    const applyDark = (dark: boolean) => root.classList.toggle("dark", dark);
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      applyDark(mq.matches);
      const on = (e: MediaQueryListEvent) => applyDark(e.matches);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    }
    applyDark(theme === "dark");
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--c-accent", accent);
  }, [accent]);
}
