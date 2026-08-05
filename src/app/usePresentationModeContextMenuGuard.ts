import { useEffect } from "react";

/**
 * Suppress terminal-canvas context-menu paths while leaving pointer down
 * and up events untouched so xterm can still encode application mouse input.
 */
export function usePresentationModeContextMenuGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const suppressContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-terminal-canvas]")) return;
      event.preventDefault();
    };

    document.addEventListener("contextmenu", suppressContextMenu, { capture: true });
    return () => document.removeEventListener("contextmenu", suppressContextMenu, { capture: true });
  }, [active]);
}
