import type { RefObject } from "react";
import type { WebglAddon } from "@xterm/addon-webgl";

/**
 * Root cause of "terminal text garbles after sitting idle, fixed by resizing":
 * the WebGL renderer bakes glyphs into a GPU texture atlas that goes stale —
 * macOS WebView drops it while the window is unfocused/occluded, and a
 * font/theme/ligature change rebakes glyphs the cached atlas no longer matches.
 * term.refresh() only repaints dirty rows; it does not rebuild the atlas. The
 * only thing that did was a resize (which forces a full redraw), so an idle
 * window showed garbled glyphs until the user resized it.
 *
 * Every invalidation path funnels through the rebuilder this returns, which
 * calls WebglAddon.clearTextureAtlas() (a no-op under the DOM renderer).
 */
export function createWebglAtlasRebuilder(
  webglRef: RefObject<WebglAddon | null>,
): () => void {
  return () => {
    try { webglRef.current?.clearTextureAtlas(); } catch { /* renderer torn down */ }
  };
}

/**
 * Self-heal the idle case: rebuild the atlas whenever the window regains focus
 * or visibility, so a backgrounded-then-foregrounded terminal repaints itself
 * instead of waiting for a resize.
 */
export function registerTerminalAtlasRefresh(rebuild: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "visible") rebuild();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", rebuild);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", rebuild);
  };
}
