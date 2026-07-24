import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuIconName = "terminal" | "ssh" | "editor" | "copy" | "download" | "rename" | "search" | "close" | "folder" | "pin" | "note" | "mascot";

export interface MenuItem {
  id?: string;
  label: string;
  action: () => void;
  icon?: MenuIconName;
  danger?: boolean;
  disabled?: boolean;
}

export type MenuEntry = MenuItem | null;

interface ContextMenuProps {
  items: MenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
}

function MenuIcon({ name }: { name: MenuIconName }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (name === "terminal") {
    return (
      <svg {...common}>
        <polyline points="4 7 10 12 4 17" />
        <line x1="12" y1="17" x2="20" y2="17" />
      </svg>
    );
  }
  if (name === "ssh") {
    return (
      <svg {...common}>
        <rect x="2.5" y="4" width="19" height="16" rx="2" />
        <path d="m6 9 3 3-3 3" />
        <path d="M12 15h5" />
      </svg>
    );
  }
  if (name === "folder") {
    return (
      <svg {...common}>
        <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        <path d="M3 9h18" />
      </svg>
    );
  }
  if (name === "editor") {
    return (
      <svg {...common}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </svg>
    );
  }
  if (name === "copy") {
    return (
      <svg {...common}>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }
  if (name === "download") {
    return (
      <svg {...common}>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    );
  }
  if (name === "rename") {
    return (
      <svg {...common}>
        <path d="M4 7h10" />
        <path d="M4 17h8" />
        <path d="M16 15l3 3 3-7Z" />
      </svg>
    );
  }
  if (name === "search") {
    return (
      <svg {...common}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
    );
  }
  if (name === "pin") {
    return (
      <svg {...common}>
        <path d="M12 3l3 6 6 .9-4.5 4.3 1.1 6.1L12 17.4 6.4 20.3l1.1-6.1L3 9.9 9 9z" />
      </svg>
    );
  }
  if (name === "note") {
    return (
      <svg {...common}>
        <path d="M5 4h10l4 4v12H5z" />
        <path d="M15 4v5h5" />
        <path d="M8 13h8" />
        <path d="M8 17h5" />
      </svg>
    );
  }
  if (name === "mascot") {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="2" />
        <circle cx="17" cy="7" r="2" />
        <circle cx="4.5" cy="13" r="1.8" />
        <circle cx="19.5" cy="13" r="1.8" />
        <path d="M8 18.2c0-2.6 1.8-4.7 4-4.7s4 2.1 4 4.7c0 1.6-1.3 2.8-2.8 2.1L12 19.7l-1.2.6C9.3 21 8 19.8 8 18.2Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

function menuEntryKey(items: MenuEntry[], entry: MenuEntry, index: number): string {
  if (entry) return entry.id ?? `${entry.icon ?? "item"}:${entry.label}`;
  const before = [...items.slice(0, index)].reverse().find(Boolean)?.label ?? "start";
  const after = items.slice(index + 1).find(Boolean)?.label ?? "end";
  return `separator:${before}:${after}`;
}

export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const onCloseRef = useRef(onClose);
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
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const menu = ref.current;
    menu?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      const focused = document.activeElement;
      const focusStayedInMenu = focused === document.body || focused === menu || !focused?.isConnected;
      if (returnFocus?.isConnected && focusStayedInMenu) returnFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

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
      aria-activedescendant={`${menuId}-item-${activeIndex}`}
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
        maxHeight: "min(420px, calc(100vh - 16px))",
        overflowY: "auto",
        overscrollBehavior: "contain",
        outline: "none",
        animation: "ctxMenuIn var(--duration-fast) ease",
      }}
    >
      {items.map((entry, i) => {
        if (entry === null) {
          return <div key={menuEntryKey(items, entry, i)} role="separator" className="ctx-divider" />;
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
            key={menuEntryKey(items, item, i)}
            role="menuitem"
            id={`${menuId}-item-${i}`}
            data-menu-index={i}
            aria-disabled={item.disabled ? true : undefined}
            tabIndex={-1}
            className={cls}
            data-active={active ? "true" : undefined}
            onMouseEnter={() => {
              if (!item.disabled) setActiveIndex(i);
            }}
            onClick={() => {
              runItem(i);
            }}
            style={{
              height: 30,
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: "var(--fs-body)",
              fontFamily: "var(--font-ui)",
              cursor: item.disabled ? "default" : "pointer",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 14,
                height: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: item.danger ? "var(--c-error)" : "var(--c-text-5)",
                flexShrink: 0,
              }}
            >
              {item.icon ? <MenuIcon name={item.icon} /> : null}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
