import type { CSSProperties, RefObject } from "react";
import { CloseIcon, SearchIcon } from "./shared";

interface TerminalSearchBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  count: { current: number; total: number } | null;
  useRegex: boolean;
  caseSensitive: boolean;
  onQueryChange: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onToggleRegex: () => void;
  onToggleCaseSensitive: () => void;
}

const SEARCH_BUTTON_STYLE: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: "var(--r-btn)",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const TOGGLE_STYLE: CSSProperties = {
  ...SEARCH_BUTTON_STYLE,
  fontSize: 11,
  fontWeight: 700,
  fontFamily: "var(--font-mono)",
  lineHeight: 1,
};

export function TerminalSearchBar({
  inputRef,
  query,
  count,
  useRegex,
  caseSensitive,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
  onToggleRegex,
  onToggleCaseSensitive,
}: TerminalSearchBarProps) {
  const hasResults = count && count.total > 0;
  const noMatch = count && count.total === 0 && query.length > 0;

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 12,
        zIndex: 30,
        background: "var(--c-bg-white)",
        border: "1px solid var(--c-border-2)",
        borderRadius: "var(--r-input)",
        padding: "5px 6px 5px 10px",
        display: "flex",
        alignItems: "center",
        gap: 3,
        boxShadow: "var(--shadow-menu)",
        animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
      }}
    >
      <SearchIcon size={13} color={hasResults ? "var(--c-accent)" : noMatch ? "var(--c-error)" : "var(--c-text-5)"} />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
        autoFocus
        placeholder="搜索…"
        style={{
          border: "none",
          background: "transparent",
          outline: "none",
          fontSize: "var(--fs-body)",
          lineHeight: "20px",
          color: "var(--c-text-primary)",
          fontFamily: "var(--font-ui)",
          width: 180,
        }}
      />

      <div style={{ width: 1, height: 16, background: "var(--c-border-2)", flexShrink: 0, margin: "0 2px" }} />

      <button
        onClick={onToggleRegex}
        title="正则表达式"
        className="hover-bg"
        style={{
          ...TOGGLE_STYLE,
          color: useRegex ? "var(--c-accent)" : "var(--c-text-5)",
          background: useRegex ? "var(--c-accent-bg-light)" : undefined,
          border: useRegex ? "1px solid var(--c-accent-border)" : "1px solid transparent",
          borderRadius: 5,
        }}
      >
        .*
      </button>
      <button
        onClick={onToggleCaseSensitive}
        title="区分大小写"
        className="hover-bg"
        style={{
          ...TOGGLE_STYLE,
          color: caseSensitive ? "var(--c-accent)" : "var(--c-text-5)",
          background: caseSensitive ? "var(--c-accent-bg-light)" : undefined,
          border: caseSensitive ? "1px solid var(--c-accent-border)" : "1px solid transparent",
          borderRadius: 5,
        }}
      >
        Aa
      </button>

      <span
        aria-hidden={!count}
        style={{
          fontSize: "var(--fs-meta)",
          color: noMatch ? "var(--c-error)" : "var(--c-text-4)",
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          flexShrink: 0,
          minWidth: 36,
          textAlign: "center",
          lineHeight: "20px",
          visibility: count ? "visible" : "hidden",
        }}
      >
        {!count ? "0" : count.total === 0 ? "0" : `${count.current}/${count.total}`}
      </span>

      <div style={{ width: 1, height: 16, background: "var(--c-border-2)", flexShrink: 0, margin: "0 2px" }} />

      <button onClick={onPrev} title="上一个 ⇧Enter" className="hover-bg" style={SEARCH_BUTTON_STYLE}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button onClick={onNext} title="下一个 Enter" className="hover-bg" style={SEARCH_BUTTON_STYLE}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button onClick={onClose} title="关闭 Esc" className="hover-bg" style={SEARCH_BUTTON_STYLE}>
        <CloseIcon size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}
