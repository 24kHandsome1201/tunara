import { useEffect, useMemo, useRef, useState } from "react";
import { quickSelectHint, type TerminalQuickSelectItem } from "@/modules/terminal/lib/terminal-quick-select";

interface TerminalQuickSelectProps {
  items: TerminalQuickSelectItem[];
  onClose: () => void;
  onCopy: (item: TerminalQuickSelectItem) => void;
  onOpen: (item: TerminalQuickSelectItem) => void;
}

export function TerminalQuickSelect({ items, onClose, onCopy, onOpen }: TerminalQuickSelectProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [typedHint, setTypedHint] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const hintedItems = useMemo(
    () => items.map((item, index) => ({ item, hint: quickSelectHint(index) })),
    [items],
  );

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    const selected = listRef.current?.querySelector(`[data-quick-select-index="${selectedIndex}"]`) as HTMLElement | null;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function selectByHint(key: string) {
    const next = `${typedHint}${key.toLowerCase()}`;
    const exact = hintedItems.findIndex(({ hint }) => hint === next);
    if (exact >= 0) {
      onCopy(hintedItems[exact].item);
      return;
    }
    const prefix = hintedItems.findIndex(({ hint }) => hint.startsWith(next));
    if (prefix >= 0) {
      setTypedHint(next);
      setSelectedIndex(prefix);
      return;
    }
    const restart = hintedItems.findIndex(({ hint }) => hint.startsWith(key.toLowerCase()));
    setTypedHint(restart >= 0 ? key.toLowerCase() : "");
    if (restart >= 0) setSelectedIndex(restart);
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1100,
          background: "var(--backdrop-color)",
          backdropFilter: "var(--backdrop-blur)",
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        role="dialog"
        tabIndex={-1}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setTypedHint("");
            setSelectedIndex((index) => Math.min(index + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setTypedHint("");
            setSelectedIndex((index) => Math.max(index - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const item = hintedItems[selectedIndex]?.item;
            if (item) {
              if ((e.metaKey || e.ctrlKey) && item.kind !== "text") onOpen(item);
              else onCopy(item);
            }
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            selectByHint(e.key);
          }
        }}
        style={{
          position: "fixed",
          top: "14%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 560,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "62vh",
          zIndex: 1101,
          outline: "none",
          background: "var(--c-bg-white)",
          border: "1px solid var(--c-border-2)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 700, color: "var(--c-text-primary)" }}>快速选择</span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{items.length}</span>
        </div>
        <div ref={listRef} className="no-scrollbar scroll-fade-y" style={{ overflowY: "auto", padding: "6px 0" }}>
          {hintedItems.map(({ item, hint }, index) => {
            const selected = index === selectedIndex;
            return (
              <div
                key={item.id}
                data-quick-select-index={index}
                onMouseEnter={() => setSelectedIndex(index)}
                onDoubleClick={() => item.kind === "text" ? onCopy(item) : onOpen(item)}
                style={{
                  margin: "0 6px",
                  padding: "7px 8px",
                  borderRadius: "var(--r-btn)",
                  display: "grid",
                  gridTemplateColumns: "34px minmax(0, 1fr) auto",
                  alignItems: "center",
                  gap: 8,
                  background: selected ? "var(--c-accent-bg-light)" : "transparent",
                }}
              >
                <span style={{ height: 22, minWidth: 26, padding: "0 6px", borderRadius: 5, display: "inline-flex", alignItems: "center", justifyContent: "center", background: selected ? "var(--c-accent)" : "var(--c-bg-3)", color: selected ? "var(--c-btn-primary-text)" : "var(--c-text-3)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", fontWeight: 700 }}>
                  {hint}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--c-text-primary)", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)" }}>{item.label}</div>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--c-text-5)", fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", marginTop: 1 }}>{item.detail}</div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => onCopy(item)} className="hover-bg" style={{ height: 26, padding: "0 8px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}>复制</button>
                  {item.kind !== "text" && <button onClick={() => onOpen(item)} className="hover-bg" style={{ height: 26, padding: "0 8px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}>打开</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
