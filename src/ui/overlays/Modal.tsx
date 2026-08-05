import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { shouldRestoreFocusAfterTrapUnmount } from "./focus-trap-policy";

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const activeModalStack: symbol[] = [];

export type ModalCloseReason = "escape" | "backdrop" | "stale-binding";
export type ModalFocusReturnToken = HTMLElement | RefObject<HTMLElement | null> | null;

interface ModalBehaviorOptions {
  active?: boolean;
  onRequestClose?: (reason: ModalCloseReason) => void;
  initialFocus?: RefObject<HTMLElement | null> | string | "container";
  returnFocusToken?: ModalFocusReturnToken;
  bindingKey?: string | null;
  currentBindingKey?: string | null;
}

function resolveFocusToken(token: ModalFocusReturnToken | undefined): HTMLElement | null {
  if (!token) return null;
  return token instanceof HTMLElement ? token : token.current;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

/**
 * Shared modal lifecycle contract. It owns safe initial focus, the focus trap,
 * Escape, binding invalidation, and conservative focus restoration. Consumers
 * still own the semantic action taken for each close reason.
 */
export function useModalBehavior(
  ref: RefObject<HTMLElement | null>,
  options: ModalBehaviorOptions = {},
) {
  const {
    active = true,
    initialFocus,
    returnFocusToken,
    bindingKey,
    currentBindingKey,
  } = options;
  const closeRef = useRef(options.onRequestClose);
  closeRef.current = options.onRequestClose;

  useLayoutEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const modalToken = Symbol("modal");
    activeModalStack.push(modalToken);
    const explicitReturn = resolveFocusToken(returnFocusToken);
    const previousFocus = explicitReturn
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const initial = initialFocus === "container"
      ? container
      : typeof initialFocus === "string"
        ? container.querySelector<HTMLElement>(initialFocus)
        : initialFocus?.current;
    (initial ?? focusableElements(container)[0] ?? container).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (activeModalStack[activeModalStack.length - 1] !== modalToken) return;
      if (event.key === "Escape" && closeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current("escape");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focused = document.activeElement;
      const inside = focused instanceof Node && container.contains(focused);
      if (event.shiftKey && (!inside || focused === first)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (!inside || focused === last)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const stackIndex = activeModalStack.lastIndexOf(modalToken);
      if (stackIndex >= 0) activeModalStack.splice(stackIndex, 1);
      const focused = document.activeElement as HTMLElement | null;
      const focusedInside = !!focused && container.contains(focused);
      const focusedAtRoot = !focused
        || focused === document.body
        || focused === document.documentElement;
      if (
        previousFocus?.isConnected
        && shouldRestoreFocusAfterTrapUnmount(focusedInside, focusedAtRoot)
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [active, bindingKey, initialFocus, ref, returnFocusToken]);

  useEffect(() => {
    if (
      active
      && bindingKey !== undefined
      && currentBindingKey !== undefined
      && bindingKey !== currentBindingKey
    ) {
      closeRef.current?.("stale-binding");
    }
  }, [active, bindingKey, currentBindingKey]);
}

interface ModalProps {
  active?: boolean;
  labelledBy: string;
  describedBy?: string;
  children: ReactNode;
  onRequestClose: (reason: ModalCloseReason) => void;
  initialFocus?: RefObject<HTMLElement | null> | string | "container";
  returnFocusToken?: ModalFocusReturnToken;
  bindingKey?: string | null;
  currentBindingKey?: string | null;
  closeOnBackdrop?: boolean;
  backdropZIndex?: number;
  zIndex?: number;
  className?: string;
  style?: CSSProperties;
}

/** Shared, viewport-safe dialog shell for app-owned modals. */
export const Modal = forwardRef<HTMLDivElement, ModalProps>(function Modal({
  active = true,
  labelledBy,
  describedBy,
  children,
  onRequestClose,
  initialFocus,
  returnFocusToken,
  bindingKey,
  currentBindingKey,
  closeOnBackdrop = true,
  backdropZIndex = 300,
  zIndex = 301,
  className,
  style,
}, forwardedRef) {
  const localRef = useRef<HTMLDivElement>(null);
  useModalBehavior(localRef, {
    active,
    onRequestClose,
    initialFocus,
    returnFocusToken,
    bindingKey,
    currentBindingKey,
  });
  if (!active) return null;
  return (
    <>
      <div
        aria-hidden="true"
        onClick={closeOnBackdrop ? () => onRequestClose("backdrop") : undefined}
        style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: backdropZIndex }}
      />
      <div
        ref={(node) => {
          localRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={className}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "calc(100dvh - 24px)",
          minHeight: 0,
          overflow: "auto",
          overscrollBehavior: "contain",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex,
          outline: "none",
          ...style,
        }}
      >
        {children}
      </div>
    </>
  );
});
