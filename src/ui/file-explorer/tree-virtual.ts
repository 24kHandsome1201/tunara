interface VirtualRange {
  first: number;
  last: number;
}

/**
 * Merge the viewport range with path-owned rows that must remain mounted for
 * focus, drag targeting, or context-menu focus return.
 */
export function mountedTreeRowIndexes(
  total: number,
  range: VirtualRange,
  forcedIndexes: Iterable<number>,
): number[] {
  const indexes = new Set<number>();
  const first = Math.max(0, Math.min(total, range.first));
  const last = Math.max(first, Math.min(total, range.last));
  for (let index = first; index < last; index += 1) indexes.add(index);
  for (const index of forcedIndexes) {
    if (Number.isInteger(index) && index >= 0 && index < total) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}
