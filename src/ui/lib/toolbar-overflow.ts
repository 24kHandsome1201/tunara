/**
 * Pack leading toolbar items into the available width and send the rest to
 * an overflow control. `itemWidths` is parallel to `items`.
 *
 * When every item fits, the overflow control is omitted unless
 * `reserveOverflowControl` is set (for items that are overflow-only, such as
 * a hidden Files action).
 */
export function splitToolbarOverflow<T>(
  items: readonly T[],
  itemWidths: readonly number[],
  availableWidth: number,
  overflowControlWidth: number,
  gap = 0,
  reserveOverflowControl = false,
): { visible: T[]; overflow: T[] } {
  const count = Math.min(items.length, itemWidths.length);
  const packed = items.slice(0, count);
  const widths = itemWidths.slice(0, count);

  const itemsWidth = (n: number) => {
    if (n <= 0) return 0;
    let width = 0;
    for (let i = 0; i < n; i++) width += widths[i] ?? 0;
    return width + gap * Math.max(0, n - 1);
  };

  if (!reserveOverflowControl && itemsWidth(count) <= availableWidth) {
    return { visible: packed as T[], overflow: [] };
  }

  let visibleCount = count;
  while (visibleCount > 0) {
    const needed = itemsWidth(visibleCount) + gap + overflowControlWidth;
    if (needed <= availableWidth) break;
    visibleCount -= 1;
  }

  return {
    visible: packed.slice(0, visibleCount) as T[],
    overflow: packed.slice(visibleCount) as T[],
  };
}
