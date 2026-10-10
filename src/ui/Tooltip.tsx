import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatShortcut } from "./formatShortcut";
import { motionDurationMs } from "./lib/motion";

/**
 * Lightweight themed tooltip replacing native `title` on icon buttons.
 * Wraps a single trigger element: hover AND keyboard focus show the bubble
 * after --delay-tooltip; Escape or leaving hides it. The trigger gets
 * aria-describedby pointing at the role="tooltip" element. Keep the trigger's
 * own aria-label — the tooltip duplicates it visually, not semantically.
 * `shortcut` takes a raw keybinding string and renders it via <kbd> +
 * formatShortcut so tooltips and menus share one shortcut format.
 * The bubble portals to document.body so ancestors with transform/filter
 * cannot re-anchor position:fixed, then a layout effect measures the real
 * bubble size and clamps it inside the viewport (flipping above the
 * trigger when it would overflow the bottom edge).
 */
export function Tooltip({
  label,
  shortcut,
  style,
  children,
}: {
  label: ReactNode;
  /** Raw keybinding string (e.g. "mod+b") rendered through formatShortcut. */
  shortcut?: string;
  /** Extra styles for the wrapper span (e.g. flex: 1 for row-filling triggers). */
  style?: CSSProperties;
  children: ReactElement;
}) {
  const tipId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [anchor, setAnchor] = useState<{ cx: number; top: number; triggerTop: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const cancelTimer = () => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };
  const show = () => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos(null);
      setAnchor({ cx: rect.left + rect.width / 2, top: rect.bottom + 6, triggerTop: rect.top });
    }, motionDurationMs("--delay-tooltip", 400));
  };
  const hide = () => {
    cancelTimer();
    setAnchor(null);
    setPos(null);
  };

  // Measure the real bubble after mount and clamp it inside the viewport —
  // estimating half-width from the trigger breaks for narrow right-edge
  // triggers with wide labels.
  useLayoutEffect(() => {
    if (!anchor) return;
    const tip = tipRef.current;
    if (!tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const lo = width / 2 + 8;
    const hi = Math.max(lo, window.innerWidth - width / 2 - 8);
    const x = Math.min(Math.max(anchor.cx, lo), hi);
    let y = anchor.top;
    if (y + height + 8 > window.innerHeight) {
      const above = anchor.triggerTop - height - 6;
      y = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
    }
    setPos({ x, y });
  }, [anchor]);

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-describedby": anchor ? tipId : undefined,
      })
    : children;

  return (
    <span
      ref={wrapRef}
      style={{ display: "inline-flex", ...style }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={hide}
      onPointerDown={hide}
      onContextMenu={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {trigger}
      {anchor !== null && createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          id={tipId}
          style={{
            position: "fixed",
            left: pos ? pos.x : 0,
            top: pos ? pos.y : 0,
            transform: "translateX(-50%)",
            visibility: pos ? "visible" : "hidden",
            zIndex: "var(--z-menu)",
            padding: "4px 8px",
            borderRadius: "var(--r-badge)",
            border: "1px solid var(--c-border-1)",
            background: "var(--c-bg-white)",
            boxShadow: "var(--shadow-card)",
            color: "var(--c-text-primary)",
            fontSize: "var(--fs-meta)",
            fontFamily: "var(--font-ui)",
            fontWeight: 500,
            whiteSpace: "nowrap",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            pointerEvents: "none",
            animation: "fadeIn var(--dur-fast) var(--ease-out)",
          }}
        >
          <span>{label}</span>
          {shortcut ? <kbd className="ui-kbd">{formatShortcut(shortcut)}</kbd> : null}
        </span>,
        document.body,
      )}
    </span>
  );
}
