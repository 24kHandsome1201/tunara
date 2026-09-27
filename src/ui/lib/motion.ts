/** Bridges CSS motion tokens into code paths that need numbers (timers,
 *  scroll behavior). The tokens in tokens.css remain the single source. */

/** Reads a `--dur-*`/`--delay-*` token on the document root, in milliseconds. */
export function motionDurationMs(token: string, fallbackMs: number): number {
  if (typeof document === "undefined") return fallbackMs;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) return fallbackMs;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** True while reduced motion is active; useTheme writes the attribute from
 *  the prefers-reduced-motion media query. */
export function reduceMotionEnabled(): boolean {
  return typeof document !== "undefined" && "reduceMotion" in document.documentElement.dataset;
}
