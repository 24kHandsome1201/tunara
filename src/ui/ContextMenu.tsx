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

  return createPortal(
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
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
        boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
        padding: "4px 0",
      }}
    >
      {items.map((entry, i) => {
        if (entry === null) {
          return <div key={i} className="ctx-divider" />;
        }
        const item = entry;
        const cls = [
          "ctx-item",
          item.danger ? "ctx-item-danger" : "",
          item.disabled ? "ctx-item-disabled" : "",
        ].filter(Boolean).join(" ");
        return (
          <div
            key={i}
            role="menuitem"
            className={cls}
            onClick={() => {
              if (item.disabled) return;
              item.action();
              onClose();
            }}
            style={{
              height: 32,
              padding: "0 12px",
              display: "flex",
              alignItems: "center",
              fontSize: "var(--fs-body)",
              fontFamily: "var(--font-ui)",
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
