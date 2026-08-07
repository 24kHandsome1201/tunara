import { useEffect } from "react";

const NATIVE_CONTEXT_MENU_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "a[href]",
].join(",");

/**
 * Keep the WebView's native menu off application chrome without taking the
 * event away from component-owned menus. Editable controls and links retain
 * their useful native actions; Pure Mode continues to suppress only terminal
 * canvas menus. Pointer down/up remain untouched for xterm mouse reporting.
 */
export function usePresentationModeContextMenuGuard(pure: boolean): void {
  useEffect(() => {
    const suppressContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (pure) {
        if (!event.target.closest("[data-terminal-canvas]")) return;
      } else if (event.target.closest(NATIVE_CONTEXT_MENU_SELECTOR)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("contextmenu", suppressContextMenu, { capture: true });
    return () => document.removeEventListener("contextmenu", suppressContextMenu, { capture: true });
  }, [pure]);
}
