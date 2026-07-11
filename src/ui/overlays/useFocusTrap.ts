import { useEffect } from "react";
import { shouldRestoreFocusAfterTrapUnmount } from "./focus-trap-policy";

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Trap keyboard focus inside a modal overlay. Tab/Shift+Tab cycle within the
 * container's focusable elements instead of escaping to controls behind the
 * modal (matching the `aria-modal="true"` contract). On unmount, focus is
 * restored to whatever element was focused before the overlay opened.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const trappedContainer = ref.current;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const container = trappedContainer;
      if (!container) return;

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        // Nothing to focus inside — keep focus from leaving the modal entirely.
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      const inside = activeEl ? container.contains(activeEl) : false;

      if (e.shiftKey) {
        // Wrap backward from the first element (or when focus has escaped).
        if (!inside || activeEl === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || activeEl === last) {
        // Wrap forward from the last element (or when focus has escaped).
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const container = trappedContainer;
      const active = document.activeElement as HTMLElement | null;
      const activeInsideClosingTrap = !!active && !!container?.contains(active);
      const activeAtDocumentRoot = !active
        || active === document.body
        || active === document.documentElement;
      // Overlay transitions can mount and focus the next dialog before this
      // cleanup runs. Do not steal focus back to the terminal in that case.
      if (shouldRestoreFocusAfterTrapUnmount(activeInsideClosingTrap, activeAtDocumentRoot)) {
        prev?.focus?.();
      }
    };
  }, [ref]);
}
