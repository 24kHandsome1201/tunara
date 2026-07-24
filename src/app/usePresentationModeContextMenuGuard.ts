import { useEffect } from "react";

/**
 * Suppress every WebView/Tunara context-menu path while leaving pointer down
 * and up events untouched so xterm can still encode application mouse input.
 */
export function usePresentationModeContextMenuGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;

    const suppressContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener("contextmenu", suppressContextMenu, { capture: true });
    return () => document.removeEventListener("contextmenu", suppressContextMenu, { capture: true });
  }, [active]);
}
