export function normalizedScrollPosition(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const range = Math.max(scrollHeight - clientHeight, 0);
  if (range === 0 || !Number.isFinite(scrollTop)) return 0;
  return Math.min(Math.max(scrollTop / range, 0), 1);
}

export function scrollTopForPosition(
  ratio: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const range = Math.max(scrollHeight - clientHeight, 0);
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(Math.max(ratio, 0), 1) * range;
}
