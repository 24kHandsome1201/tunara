import { useEffect, useMemo, useRef, useState } from "react";
import { quickSelectHint, type TerminalQuickSelectItem } from "@/modules/terminal/lib/terminal-quick-select";
import { useT } from "@/modules/i18n";

interface TerminalQuickSelectProps {
  items: TerminalQuickSelectItem[];
  onClose: () => void;
  onCopy: (item: TerminalQuickSelectItem) => void;
  onOpen: (item: TerminalQuickSelectItem) => void;
}

export function TerminalQuickSelect({ items, onClose, onCopy, onOpen }: TerminalQuickSelectProps) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [typedHint, setTypedHint] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hintedItems = useMemo(
    () => items.map((item, index) => ({ item, hint: quickSelectHint(index) })),
    [items],
  );

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(0, items.length - 1)));
  }, [items.length]);

  // `autoFocus` on a generic div is not reliable in WKWebView. Focus in a
  // mount effect so a command-palette focus trap finishes unmounting first and
  // the quick-select dialog deterministically owns Escape/hint key events.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

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

  // Arrow keys step through the items still matching the typed hint prefix, so
  // incremental search isn't reset when the user reaches for the arrows. With no
  // prefix typed, every item matches and this walks the whole list.
  function stepSelection(direction: 1 | -1) {
    const matches = hintedItems
      .map(({ hint }, index) => ({ hint, index }))
      .filter(({ hint }) => hint.startsWith(typedHint));
    if (matches.length === 0) return;
    const current = matches.findIndex(({ index }) => index === selectedIndex);
    const nextPos = current < 0
      ? (direction === 1 ? 0 : matches.length - 1)
      : Math.min(matches.length - 1, Math.max(0, current + direction));
    setSelectedIndex(matches[nextPos].index);
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
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("quick_select.title")}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Tab") {
            // 焦点陷阱：Tab/Shift+Tab 在弹窗内的按钮间循环，不逃逸到背景
            e.preventDefault();
            const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
            if (buttons.length === 0) return;
            const idx = buttons.indexOf(document.activeElement as HTMLElement);
            const next = e.shiftKey
              ? buttons[idx <= 0 ? buttons.length - 1 : idx - 1]
              : buttons[idx === -1 || idx === buttons.length - 1 ? 0 : idx + 1];
            next?.focus();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            stepSelection(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            stepSelection(-1);
          } else if (e.key === "Enter") {
            // 焦点在行内按钮上时 Enter 留给按钮自己，不和 hint 键冲突
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            const item = hintedItems[selectedIndex]?.item;
            if (item) {
              if ((e.metaKey || e.ctrlKey) && item.kind !== "text") onOpen(item);
              else onCopy(item);
            }
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // 空格同理留给按钮；字母数字走 hint 增量搜索
            if (e.key === " " && (e.target as HTMLElement).closest("button")) return;
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
          <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 700, color: "var(--c-text-primary)" }}>{t("quick_select.title")}</span>
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
                // 单击即确认（原双击才能触发，单击是死区）；行内按钮 stopPropagation 防重复触发
                onClick={() => item.kind === "text" ? onCopy(item) : onOpen(item)}
                style={{
                  margin: "0 6px",
                  padding: "7px 8px",
                  borderRadius: "var(--r-btn)",
                  display: "grid",
                  gridTemplateColumns: "34px minmax(0, 1fr) auto",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
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
                <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onCopy(item)} className="hover-bg" style={{ height: 26, padding: "0 8px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}>{t("quick_select.copy")}</button>
                  {item.kind !== "text" && <button onClick={() => onOpen(item)} className="hover-bg" style={{ height: 26, padding: "0 8px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}>{t("quick_select.open")}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
