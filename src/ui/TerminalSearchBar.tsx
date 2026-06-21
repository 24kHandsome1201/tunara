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
  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 12,
        zIndex: 30,
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-2)",
        borderRadius: "var(--r-btn)",
        padding: "4px 8px",
        display: "flex",
        alignItems: "center",
        gap: 4,
        boxShadow: "var(--shadow-card)",
      }}
    >
      <SearchIcon />
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
          color: "var(--c-text-primary)",
          fontFamily: "var(--font-ui)",
          width: 200,
        }}
      />
      <button
        onClick={onToggleRegex}
        title="正则表达式"
        className="hover-bg"
        style={{ ...TOGGLE_STYLE, color: useRegex ? "var(--c-accent)" : undefined, background: useRegex ? "var(--c-accent-bg-light)" : undefined }}
      >
        .*
      </button>
      <button
        onClick={onToggleCaseSensitive}
        title="区分大小写"
        className="hover-bg"
        style={{ ...TOGGLE_STYLE, color: caseSensitive ? "var(--c-accent)" : undefined, background: caseSensitive ? "var(--c-accent-bg-light)" : undefined }}
      >
        Aa
      </button>
      {count && (
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flexShrink: 0 }}>
          {count.current}/{count.total}
        </span>
      )}
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
