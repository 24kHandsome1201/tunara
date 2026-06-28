/**
 * Virtual-scroll slice math for the MiniDiff row list.
 *
 * Fixed row height is safe here because MiniDiff rows render at a constant
 * `--fs-meta` (11px) with fixed padding and `white-space: pre` — no wrapping,
 * so every row is exactly the same height regardless of content. The height
 * is measured once at mount (see MiniDiff) rather than hardcoded, so a future
 * token change doesn't silently desync the slice.
 *
 * Pure functions so the slice math is unit-testable without a DOM.
 */

export interface VirtualSlice {
  /** Index of the first rendered row (inclusive). */
  first: number;
  /** Index of the last rendered row (exclusive). */
  last: number;
  /** Pixel height of the top spacer (first * rowHeight). */
  topPad: number;
  /** Pixel height of the bottom spacer ((total - last) * rowHeight). */
  bottomPad: number;
}

/** Rows rendered above/below the viewport so scrolling doesn't flash empty. */
export const VIRTUAL_BUFFER = 8;

/**
 * Compute the visible row slice for a scroll position.
 *
 * @param total       Total row count.
 * @param scrollTop   Current container scrollTop (px).
 * @param viewport    Container clientHeight (px).
 * @param rowHeight   Measured row height (px).
 * @param buffer      Extra rows above/below the viewport (default 8).
 * @returns           Slice descriptor; `first === 0 && last === 0` when empty.
 */
export function computeVirtualSlice(
  total: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  buffer: number = VIRTUAL_BUFFER,
): VirtualSlice {
  if (total <= 0 || rowHeight <= 0 || viewport <= 0) {
    return { first: 0, last: 0, topPad: 0, bottomPad: 0 };
  }
  const safeRowHeight = rowHeight;
  const maxScroll = Math.max(0, total * safeRowHeight - viewport);
  // Clamp scrollTop so a filtered (shorter) list doesn't leave the scroll
  // position past the new content, which would render an empty viewport.
  const clampedScroll = Math.min(Math.max(0, scrollTop), maxScroll);

  const firstVisible = Math.floor(clampedScroll / safeRowHeight);
  const visibleCount = Math.ceil(viewport / safeRowHeight);
  const first = Math.max(0, firstVisible - buffer);
  const last = Math.min(total, firstVisible + visibleCount + buffer);

  return {
    first,
    last,
    topPad: first * safeRowHeight,
    bottomPad: (total - last) * safeRowHeight,
  };
}
