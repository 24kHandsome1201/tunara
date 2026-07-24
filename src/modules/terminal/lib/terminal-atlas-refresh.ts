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
 * Self-heal the sustained-output case (xterm.js #6038 / #4534, fixed upstream
 * only in the unreleased 7.0 line): under heavy output with many distinct
 * glyphs (colored CJK at retina DPR), addon-webgl 0.19 corrupts its shared
 * texture atlas — page merges run mid-frame and mutate glyph page/UV state
 * already baked into vertex buffers, and page-local version counters can
 * collide so stale textures are never re-uploaded. The buffer content stays
 * correct; only rendering garbles, which is why a resize (which clears the
 * atlas) always fixed it.
 *
 * Because the atlas is SHARED across every terminal with the same font config
 * (all split panes), a rebuild must clear every renderer's model in the same
 * synchronous pass — clearing just one pane leaves siblings pointing at stale
 * vertex data. Hence the module-level registry + global rebuild below.
 *
 * This is a stopgap until the upstream fix ships in a stable xterm release;
 * remove it (and the output-pressure heuristic) after upgrading.
 */
const atlasRebuilders = new Set<() => void>();

export function registerTerminalAtlasRebuilder(rebuild: () => void): () => void {
  atlasRebuilders.add(rebuild);
  return () => {
    atlasRebuilders.delete(rebuild);
    // Last terminal gone: drop any pending trailing rebuild and counters.
    if (atlasRebuilders.size === 0) defaultPressureMonitor.reset();
  };
}

/** Rebuild the (shared) WebGL atlas for every live terminal, synchronously. */
export function requestGlobalTerminalAtlasRebuild(): void {
  if (atlasRebuilders.size === 0) return;
  defaultPressureMonitor.notifyRebuilt();
  for (const rebuild of [...atlasRebuilders]) {
    try { rebuild(); } catch { /* renderer torn down mid-iteration */ }
  }
}

type TimerHandle = ReturnType<typeof setTimeout>;

export const ATLAS_PRESSURE_THRESHOLD_BYTES = 512 * 1024;
export const ATLAS_PRESSURE_MIN_INTERVAL_MS = 10_000;
export const ATLAS_PRESSURE_QUIET_MS = 300;

export interface AtlasPressureMonitorOptions {
  thresholdBytes?: number;
  minIntervalMs?: number;
  quietMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
}

/**
 * Byte count is a weak proxy for glyph churn (repeated ASCII barely touches
 * the atlas; novel colored CJK fills it fast), so the threshold is deliberately
 * conservative and the rebuild is rate-limited: at most one rebuild per
 * minIntervalMs while output flows, plus one trailing rebuild once output has
 * been quiet for quietMs if pressure built up during the rate-limited window.
 */
export function createTerminalAtlasPressureMonitor(
  rebuild: () => void,
  {
    thresholdBytes = ATLAS_PRESSURE_THRESHOLD_BYTES,
    minIntervalMs = ATLAS_PRESSURE_MIN_INTERVAL_MS,
    quietMs = ATLAS_PRESSURE_QUIET_MS,
    now = () => Date.now(),
    schedule = (callback, ms) => setTimeout(callback, ms),
    cancel = (handle) => clearTimeout(handle),
  }: AtlasPressureMonitorOptions = {},
) {
  let bytesSinceRebuild = 0;
  let lastRebuildAt = -Infinity;
  let quietTimer: TimerHandle | null = null;

  const cancelQuietTimer = () => {
    if (quietTimer !== null) {
      cancel(quietTimer);
      quietTimer = null;
    }
  };

  const doRebuild = () => {
    bytesSinceRebuild = 0;
    lastRebuildAt = now();
    cancelQuietTimer();
    rebuild();
  };

  return {
    push(byteLength: number) {
      bytesSinceRebuild += byteLength;
      if (bytesSinceRebuild < thresholdBytes) return;
      if (now() - lastRebuildAt >= minIntervalMs) {
        doRebuild();
        return;
      }
      // Pressured but rate-limited: arm/refresh a trailing quiet rebuild so
      // the final frame after a burst is guaranteed clean without waiting for
      // the min interval.
      cancelQuietTimer();
      quietTimer = schedule(() => {
        quietTimer = null;
        if (bytesSinceRebuild >= thresholdBytes) doRebuild();
      }, quietMs);
    },
    /** A rebuild happened through another path (resize, focus); reset counters. */
    notifyRebuilt() {
      bytesSinceRebuild = 0;
      lastRebuildAt = now();
      cancelQuietTimer();
    },
    /** Full reset (last terminal unmounted): forget rate-limit history too. */
    reset() {
      bytesSinceRebuild = 0;
      lastRebuildAt = -Infinity;
      cancelQuietTimer();
    },
  };
}

const defaultPressureMonitor = createTerminalAtlasPressureMonitor(() => {
  // requestGlobalTerminalAtlasRebuild also calls notifyRebuilt(); that second
  // reset is idempotent.
  requestGlobalTerminalAtlasRebuild();
});

/** Feed terminal output volume into the shared atlas pressure monitor. */
export function recordTerminalAtlasOutputPressure(byteLength: number): void {
  if (atlasRebuilders.size === 0) return;
  defaultPressureMonitor.push(byteLength);
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
