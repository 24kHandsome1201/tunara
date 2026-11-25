import type { MouseEvent as ReactMouseEvent } from "react";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";

const DRAG_START_DISTANCE_PX = 3;
const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='tab']",
].join(",");

let doubleClickSurface: HTMLElement | null = null;

function isSurfacePress(surface: HTMLElement, event: MouseEvent | ReactMouseEvent<HTMLElement>) {
  const target = event.target;
  return (
    event.button === 0
    && target instanceof Element
    && surface.contains(target)
    && !target.closest(INTERACTIVE_SELECTOR)
  );
}

/** Only a press right after a press on the same drag surface may count as its double-click. */
function armDoubleClick(surface: HTMLElement) {
  doubleClickSurface = surface;
  const disarmUnlessSurfacePress = (next: MouseEvent) => {
    if (!isSurfacePress(surface, next)) doubleClickSurface = null;
  };
  window.addEventListener("mousedown", disarmUnlessSurfacePress, { capture: true, once: true });
}

/**
 * Titlebar drag and double-click maximize for borderless (Linux) chrome.
 *
 * Tauri's drag region starts a native window move on the first press, and the
 * window manager's move grab swallows the second press, so its double-click
 * never reaches the webview. Dragging only once the pointer moves keeps plain
 * clicks inside the webview, where they count up to a double-click.
 */
export function handleBorderlessTitlebarMouseDown(event: ReactMouseEvent<HTMLElement>) {
  const surface = event.currentTarget;
  if (!isSurfacePress(surface, event)) return;
  const win = tryGetCurrentWindow();
  if (!win) return;
  event.preventDefault();

  if (event.detail === 2) {
    if (doubleClickSurface !== surface) return;
    doubleClickSurface = null;
    void win.toggleMaximize();
    return;
  }
  if (event.detail !== 1) return;
  armDoubleClick(surface);

  const { screenX: startX, screenY: startY } = event;
  const stop = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
  };
  const onMove = (move: MouseEvent) => {
    if (
      Math.abs(move.screenX - startX) < DRAG_START_DISTANCE_PX
      && Math.abs(move.screenY - startY) < DRAG_START_DISTANCE_PX
    ) {
      return;
    }
    stop();
    void win.startDragging();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
}
