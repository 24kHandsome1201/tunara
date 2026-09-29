import { cloneElement, isValidElement, useId, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
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
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
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
      const half = Math.max(rect.width, 80) / 2;
      setPos({
        x: Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8),
        y: rect.bottom + 6,
      });
    }, motionDurationMs("--delay-tooltip", 400));
  };
  const hide = () => {
    cancelTimer();
    setPos(null);
  };

  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-describedby": pos ? tipId : undefined,
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
      onKeyDown={(event) => {
        if (event.key === "Escape") hide();
      }}
    >
      {trigger}
      {pos !== null && (
        <span
          role="tooltip"
          id={tipId}
          style={{
            position: "fixed",
            left: pos.x,
            top: pos.y,
            transform: "translateX(-50%)",
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
        </span>
      )}
    </span>
  );
}
