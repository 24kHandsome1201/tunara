import { useModalBehavior } from "./Modal";

/**
 * Trap keyboard focus inside a modal overlay. Tab/Shift+Tab cycle within the
 * container's focusable elements instead of escaping to controls behind the
 * modal (matching the `aria-modal="true"` contract). On unmount, focus is
 * restored to whatever element was focused before the overlay opened.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active = true) {
  useModalBehavior(ref, { active });
}
