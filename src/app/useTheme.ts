import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore } from "@/state/ui";
import { applyBootShellTint } from "@/styles/shell-tint-boot";
import { getTerminalTheme } from "@/styles/terminalTheme";

export function useTheme() {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);

  useEffect(() => {
    const root = document.documentElement;

    const apply = (systemDark: boolean) => {
      applyBootShellTint(root, theme, accent, systemDark);
      root.style.setProperty("--terminal-canvas-bg", getTerminalTheme(theme, accent).background);
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

  const backgroundOpacity = useUIStore((s) => s.backgroundOpacity);
  const backgroundBlur = useUIStore((s) => s.backgroundBlur);
  useEffect(() => {
    if (!IS_MAC) return;
    const root = document.documentElement;
    const translucent = backgroundOpacity < 1;
    if (translucent) {
      root.dataset.windowTranslucent = "";
      root.style.setProperty("--window-bg-opacity", `${Math.round(backgroundOpacity * 100)}%`);
    } else {
      delete root.dataset.windowTranslucent;
      root.style.removeProperty("--window-bg-opacity");
    }
    invoke("set_window_background_blur", { enabled: translucent && backgroundBlur }).catch(() => {});
  }, [backgroundOpacity, backgroundBlur]);
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
