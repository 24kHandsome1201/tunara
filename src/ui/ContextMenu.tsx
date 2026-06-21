import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | null;

interface ContextMenuProps {
  items: MenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: position.x, y: position.y });
  const firstEnabled = Math.max(0, items.findIndex((entry) => entry && !entry.disabled));
  const [activeIndex, setActiveIndex] = useState(firstEnabled);

  const enabledIndices = items
    .map((entry, i) => (entry && !entry.disabled ? i : -1))
    .filter((i) => i >= 0);

  const runItem = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    item.action();
    onClose();
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (x + rect.width > window.innerWidth) x = Math.max(0, position.x - rect.width);
    if (y + rect.height > window.innerHeight) y = Math.max(0, position.y - rect.height);
    setPos({ x, y });
  }, [position.x, position.y]);

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onResize = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  function moveActive(delta: number) {
    if (enabledIndices.length === 0) return;
    const current = enabledIndices.indexOf(activeIndex);
    const next = current < 0
      ? 0
      : (current + delta + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[next]);
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveActive(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveActive(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          if (enabledIndices.length > 0) setActiveIndex(enabledIndices[0]);
        } else if (e.key === "End") {
          e.preventDefault();
          if (enabledIndices.length > 0) setActiveIndex(enabledIndices[enabledIndices.length - 1]);
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          runItem(activeIndex);
        }
      }}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        minWidth: 180,
        maxWidth: 260,
        zIndex: 9999,
        background: "var(--c-bg-white)",
        border: "1px solid var(--c-border-2)",
        borderRadius: "var(--r-input)",
        boxShadow: "var(--shadow-menu)",
        padding: "4px 0",
        outline: "none",
      }}
    >
      {items.map((entry, i) => {
        if (entry === null) {
          return <div key={`sep-${i}`} role="separator" className="ctx-divider" />;
        }
        const item = entry;
        const active = activeIndex === i && !item.disabled;
        const cls = [
          "ctx-item",
          item.danger ? "ctx-item-danger" : "",
          item.disabled ? "ctx-item-disabled" : "",
        ].filter(Boolean).join(" ");
        return (
          <div
            key={`${item.label}-${i}`}
            role="menuitem"
            aria-disabled={item.disabled ? true : undefined}
            tabIndex={-1}
            className={cls}
            onMouseEnter={() => {
              if (!item.disabled) setActiveIndex(i);
            }}
            onClick={() => {
              runItem(i);
            }}
            style={{
              height: 32,
              padding: "0 12px",
              display: "flex",
              alignItems: "center",
              fontSize: "var(--fs-body)",
              fontFamily: "var(--font-ui)",
              background: active ? "var(--c-bg-hover)" : undefined,
              color: active ? "var(--c-text-primary)" : undefined,
              cursor: item.disabled ? "default" : "pointer",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.label}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
