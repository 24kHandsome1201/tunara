export interface BadgeDecision {
  changed: boolean;
  value: number | undefined;
}

export function decideBadge(prev: number | null, count: number): BadgeDecision {
  if (prev === count) return { changed: false, value: count > 0 ? count : undefined };
  return { changed: true, value: count > 0 ? count : undefined };
}

export interface DockBadgeController {
  set(count: number): { changed: boolean; value: number | undefined };
  peek(): number | null;
  reset(): void;
}

export function createDockBadgeController(): DockBadgeController {
  let last: number | null = null;
  return {
    set(count: number) {
      const decision = decideBadge(last, count);
      if (decision.changed) last = count;
      return decision;
    },
    peek: () => last,
    reset() {
      last = null;
    },
  };
}
