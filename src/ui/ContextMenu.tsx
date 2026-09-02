import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { returnTerminalFocus, type TerminalFocusReturnToken } from "@/modules/terminal/lib/binding-aware-async-action";
import type { ModalFocusReturnToken } from "./overlays/Modal";
import {
  ClipboardText,
  CopySimple,
  DownloadSimple,
  FolderSimple,
  Icon,
  MagnifyingGlass,
  NotePencil,
  PencilSimple,
  PushPin,
  Terminal,
  TerminalWindow,
  TrashSimple,
} from "@/ui/icons";

export type MenuIconName = "terminal" | "ssh" | "editor" | "copy" | "paste" | "download" | "rename" | "search" | "close" | "folder" | "pin";

export interface MenuItem {
  id?: string;
  label: string;
  action: () => void;
  icon?: MenuIconName;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuHeading {
  type: "heading";
  label: string;
}

export type MenuEntry = MenuItem | MenuHeading | null;

export function isMenuHeading(entry: MenuEntry): entry is MenuHeading {
  return entry !== null && "type" in entry && entry.type === "heading";
}

export function isMenuItem(entry: MenuEntry): entry is MenuItem {
  return entry !== null && !isMenuHeading(entry);
}

interface ContextMenuProps {
  items: MenuEntry[];
  position: { x: number; y: number };
  onClose: () => void;
  terminalFocusReturnToken?: TerminalFocusReturnToken | null;
  returnFocusToken?: ModalFocusReturnToken;
  bindingKey?: string | null;
  currentBindingKey?: string | null;
}

function MenuIcon({ name }: { name: MenuIconName }) {
  const glyph = {
    terminal: Terminal,
    ssh: TerminalWindow,
    folder: FolderSimple,
    editor: PencilSimple,
    copy: CopySimple,
    paste: ClipboardText,
    download: DownloadSimple,
    rename: NotePencil,
    search: MagnifyingGlass,
    pin: PushPin,
    close: TrashSimple,
  }[name];
  return <Icon icon={glyph} size={14} />;
}

function menuEntryKey(items: MenuEntry[], entry: MenuEntry, index: number): string {
  if (isMenuHeading(entry)) return `heading:${entry.label}:${index}`;
  if (entry) return entry.id ?? `${entry.icon ?? "item"}:${entry.label}`;
  const before = [...items.slice(0, index)].reverse().find((item) => item && isMenuItem(item))?.label ?? "start";
  const after = items.slice(index + 1).find((item) => item && isMenuItem(item))?.label ?? "end";
  return `separator:${before}:${after}`;
}

function resolveFocusToken(token: ModalFocusReturnToken | undefined): HTMLElement | null {
  if (!token) return null;
  return token instanceof HTMLElement ? token : token.current;
}

export function ContextMenu({
  items,
  position,
  onClose,
  terminalFocusReturnToken,
  returnFocusToken,
  bindingKey,
  currentBindingKey,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalFocusReturnTokenRef = useRef(terminalFocusReturnToken);
  const menuId = useId();
  const onCloseRef = useRef(onClose);
  const [pos, setPos] = useState({ x: position.x, y: position.y });
  const firstEnabled = Math.max(0, items.findIndex((entry) => isMenuItem(entry) && !entry.disabled));
  const [activeIndex, setActiveIndex] = useState(firstEnabled);

  const enabledIndices = items
    .map((entry, i) => (isMenuItem(entry) && !entry.disabled ? i : -1))
    .filter((i) => i >= 0);

  const runItem = (index: number) => {
    const item = items[index];
    if (!isMenuItem(item) || item.disabled) return;
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
    const returnFocus = resolveFocusToken(returnFocusToken)
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const terminalFocusToken = terminalFocusReturnTokenRef.current;
    const menu = ref.current;
    menu?.focus();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      const focused = document.activeElement;
      const focusStayedInMenu = focused === document.body || focused === menu || !focused?.isConnected;
      if (focusStayedInMenu && terminalFocusToken) returnTerminalFocus(terminalFocusToken);
      else if (returnFocus?.isConnected && focusStayedInMenu) returnFocus.focus({ preventScroll: true });
    };
  }, [returnFocusToken]);

  useEffect(() => {
    if (
      bindingKey !== undefined
      && currentBindingKey !== undefined
      && bindingKey !== currentBindingKey
    ) {
      onCloseRef.current();
    }
  }, [bindingKey, currentBindingKey]);

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
        border: "1px solid var(--c-control-border)",
        borderRadius: "var(--r-input)",
        boxShadow: "var(--shadow-menu)",
        padding: "4px 0",
        maxHeight: "min(420px, calc(100vh - 16px))",
        overflowY: "auto",
        overflowX: "hidden",
        overscrollBehavior: "contain",
        outline: "none",
        animation: "ctxMenuIn var(--dur-fast) var(--ease-out)",
      }}
    >
      {items.map((entry, i) => {
        if (entry === null) {
          return <div key={menuEntryKey(items, entry, i)} role="separator" className="ctx-divider" />;
        }
        if (isMenuHeading(entry)) {
          return (
            <div
              key={menuEntryKey(items, entry, i)}
              role="presentation"
              className="ctx-heading"
            >
              {entry.label}
            </div>
          );
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
