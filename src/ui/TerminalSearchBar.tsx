import type { CSSProperties, RefObject } from "react";
import { CloseIcon, SearchIcon } from "./shared";
import { CaretDown, CaretUp, Icon } from "@/ui/icons";
import { useT } from "@/modules/i18n";
import { formatShortcut } from "./formatShortcut";

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
  fontSize: "var(--fs-meta)",
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
  const t = useT();
  const hasResults = count && count.total > 0;
  const noMatch = count && count.total === 0 && query.length > 0;
  const prevShortcut = formatShortcut("Shift+Enter");
  const nextShortcut = formatShortcut("Enter");
  const closeShortcut = formatShortcut("Escape");

  return (
    <div
      style={{
        position: "absolute",
        top: 38,
        right: 12,
        left: 12,
        maxWidth: "max-content",
        zIndex: 30,
        background: "var(--c-bg-white)",
        border: "1px solid var(--c-control-border)",
        borderRadius: "var(--r-input)",
        padding: "5px 6px 5px 10px",
        display: "flex",
        alignItems: "center",
        gap: 3,
        flexWrap: "wrap",
        boxShadow: "var(--shadow-menu)",
        animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
      }}
    >
      <SearchIcon size={13} color={hasResults ? "var(--c-accent)" : noMatch ? "var(--c-error)" : "var(--c-text-5)"} />
      <input
        className="ui-native-control"
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
        aria-label={t("term.search.placeholder")}
        placeholder={t("term.search.placeholder")}
        style={{
          border: "none",
          background: "transparent",
          outline: "none",
          fontSize: "var(--fs-body)",
          lineHeight: "20px",
          color: "var(--c-text-primary)",
          fontFamily: "var(--font-ui)",
          width: 180,
          minWidth: 72,
          flex: "1 1 120px",
        }}
      />

      <div style={{ width: 1, height: 16, background: "var(--c-border-2)", flexShrink: 0, margin: "0 2px" }} />

      <button
        type="button"
        onClick={onToggleRegex}
        title={t("term.search.regex")}
        aria-label={t("term.search.regex")}
        aria-pressed={useRegex}
        className="hover-bg"
        style={{
          ...TOGGLE_STYLE,
          color: useRegex ? "var(--c-accent)" : "var(--c-text-5)",
          background: useRegex ? "var(--c-accent-bg-light)" : undefined,
          border: useRegex ? "1px solid var(--c-accent-border)" : "1px solid transparent",
          borderRadius: "var(--r-badge-sm)",
        }}
      >
        .*
      </button>
      <button
        type="button"
        onClick={onToggleCaseSensitive}
        title={t("term.search.case_sensitive")}
        aria-label={t("term.search.case_sensitive")}
        aria-pressed={caseSensitive}
        className="hover-bg"
        style={{
          ...TOGGLE_STYLE,
          color: caseSensitive ? "var(--c-accent)" : "var(--c-text-5)",
          background: caseSensitive ? "var(--c-accent-bg-light)" : undefined,
          border: caseSensitive ? "1px solid var(--c-accent-border)" : "1px solid transparent",
          borderRadius: "var(--r-badge-sm)",
        }}
      >
        Aa
      </button>

      <span
        aria-live="polite"
        aria-atomic="true"
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

      <button type="button" onClick={onPrev} title={`${t("term.search.prev")} ${prevShortcut}`} aria-label={`${t("term.search.prev")} ${prevShortcut}`} className="hover-bg" style={SEARCH_BUTTON_STYLE} disabled={!hasResults}>
        <Icon icon={CaretUp} size={12} weight="bold" />
      </button>
      <button type="button" onClick={onNext} title={`${t("term.search.next")} ${nextShortcut}`} aria-label={`${t("term.search.next")} ${nextShortcut}`} className="hover-bg" style={SEARCH_BUTTON_STYLE} disabled={!hasResults}>
        <Icon icon={CaretDown} size={12} weight="bold" />
      </button>
      <button type="button" onClick={onClose} title={`${t("term.search.close")} ${closeShortcut}`} aria-label={`${t("term.search.close")} ${closeShortcut}`} className="hover-bg" style={SEARCH_BUTTON_STYLE}>
        <CloseIcon size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}
