export type SplitFocusDirection = "left" | "right" | "up" | "down";

interface SplitFocusState {
  mode: "single" | "horizontal" | "vertical";
  paneA: string | null;
  paneB: string | null;
}

/**
 * Resolve directional split navigation without treating every direction as a
 * generic toggle. Horizontal panes are A=left, B=right; vertical panes are
 * A=top, B=bottom. A direction with no neighbour is a no-op.
 */
export function splitFocusTarget(
  split: SplitFocusState,
  activeSessionId: string | null,
  direction: SplitFocusDirection,
): string | null {
  const { mode, paneA, paneB } = split;
  if (mode === "single" || !paneA || !paneB) return null;

  if (mode === "horizontal") {
    if (direction === "left" && activeSessionId === paneB) return paneA;
    if (direction === "right" && activeSessionId === paneA) return paneB;
    return null;
  }

  if (direction === "up" && activeSessionId === paneB) return paneA;
  if (direction === "down" && activeSessionId === paneA) return paneB;
  return null;
}
