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

/**
 * Titlebar drag and double-click maximize for borderless (Linux) chrome.
 *
 * Tauri's drag region starts a native window move on the first press, and the
 * window manager's move grab swallows the second press, so its double-click
 * never reaches the webview. Dragging only once the pointer moves keeps plain
 * clicks inside the webview, where they count up to a double-click.
 */
export function handleBorderlessTitlebarMouseDown(event: ReactMouseEvent<HTMLElement>) {
  const target = event.target;
  if (
    event.button !== 0
    || !(target instanceof Element)
    || !event.currentTarget.contains(target)
    || target.closest(INTERACTIVE_SELECTOR)
  ) {
    return;
  }
  const win = tryGetCurrentWindow();
  if (!win) return;
  event.preventDefault();

  if (event.detail === 2) {
    void win.toggleMaximize();
    return;
  }
  if (event.detail !== 1) return;

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
