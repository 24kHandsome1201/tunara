import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterTerminalBlockOutput,
  formatTerminalBlockFilterText,
} from "@/modules/terminal/lib/terminal-block-filter";
import { CloseIcon, SearchIcon } from "./shared";
import { copyText } from "./lib/clipboard";
import { useT } from "@/modules/i18n";
import type { TerminalCommandBlock } from "@/modules/terminal/lib/terminal-blocks";

const ICON_BUTTON_STYLE = {
  width: 24,
  height: 24,
  borderRadius: "var(--r-btn)",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--c-text-5)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
} as const;

const FILTER_RENDER_LIMIT = 500;

function copyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ToggleButton({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="hover-bg"
      style={{
        ...ICON_BUTTON_STYLE,
        color: active ? "var(--c-accent)" : "var(--c-text-5)",
        background: active ? "var(--c-accent-bg-light)" : "transparent",
        borderColor: active ? "var(--c-accent-border)" : "transparent",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-meta)",
        fontWeight: 800,
      }}
    >
      {label}
    </button>
  );
}

export function TerminalBlockFilterPanel({
  block,
  output,
  onClose,
}: {
  block: TerminalCommandBlock;
  output: string;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [invert, setInvert] = useState(false);
  const [contextLines, setContextLines] = useState(0);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const requestClose = () => {
    if (closing || closeTimerRef.current) return;
    setClosing(true);
    // 与 sheetOut keyframe 时长保持一致（--duration-fast = 120ms）
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, 120);
  };

  const result = useMemo(() => filterTerminalBlockOutput(output, {
    query,
    regex,
    caseSensitive,
    invert,
    contextLines,
  }), [caseSensitive, contextLines, invert, output, query, regex]);

  const visibleLines = query.trim() ? result.lines.slice(0, FILTER_RENDER_LIMIT) : result.lines.slice(-120);
  const clipped = query.trim() && result.lines.length > visibleLines.length;
  const status = result.invalidRegex
    ? t("block.filter.regex_error")
    : query.trim()
      ? `${result.selectedCount}/${result.totalLines}`
      : `${result.totalLines}`;

  return (
    <div
      style={{
        position: "absolute",
        top: 42,
        right: 12,
        zIndex: 40,
        width: "min(720px, calc(100% - 24px))",
        maxHeight: "min(420px, calc(100% - 70px))",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--c-bg-white)",
        border: "1px solid var(--c-border-2)",
        borderRadius: "var(--r-input)",
        boxShadow: "var(--shadow-menu)",
        animation: closing
          ? "sheetOut var(--duration-fast) var(--ease-smooth) forwards"
          : "sheetIn var(--duration-normal) var(--ease-out-back)",
      }}
    >
      <div style={{ height: 38, display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}>
        <SearchIcon size={13} color={result.invalidRegex ? "var(--c-error)" : query ? "var(--c-accent)" : "var(--c-text-5)"} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              requestClose();
            }
          }}
          placeholder={t("block.filter.placeholder")}
          style={{
            minWidth: 120,
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--c-text-primary)",
            fontSize: "var(--fs-body)",
            fontFamily: "var(--font-ui)",
          }}
        />
        <ToggleButton active={regex} label=".*" title={t("block.filter.regex")} onClick={() => setRegex((value) => !value)} />
        <ToggleButton active={caseSensitive} label="Aa" title={t("block.filter.case_sensitive")} onClick={() => setCaseSensitive((value) => !value)} />
        <ToggleButton active={invert} label="≠" title={t("block.filter.invert")} onClick={() => setInvert((value) => !value)} />
        <input
          value={contextLines}
          type="number"
          min={0}
          max={10}
          title={t("block.filter.context_lines")}
          onChange={(event) => setContextLines(Number(event.target.value))}
          style={{
            width: 42,
            height: 24,
            border: "1px solid var(--c-border-2)",
            borderRadius: "var(--r-btn)",
            background: "var(--c-bg-2)",
            color: "var(--c-text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-meta)",
            textAlign: "center",
          }}
        />
        <span style={{ minWidth: 48, textAlign: "center", color: result.invalidRegex ? "var(--c-error)" : "var(--c-text-4)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", fontWeight: 700 }}>
          {status}
        </span>
        <button
          onClick={async () => {
            const text = query.trim() ? formatTerminalBlockFilterText(result) : output;
            if (!(await copyText(text))) return;
            setCopied(true);
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => {
              copiedTimerRef.current = null;
              setCopied(false);
            }, 1200);
          }}
          title={t("block.filter.copy_result")}
          className="hover-bg"
          style={{ ...ICON_BUTTON_STYLE, color: copied ? "var(--c-success)" : "var(--c-text-5)" }}
        >
          {copied ? "✓" : copyIcon()}
        </button>
        <button onClick={requestClose} title={t("block.filter.close")} aria-label={t("common.close")} className="hover-bg" style={ICON_BUTTON_STYLE}>
          <CloseIcon size={12} strokeWidth={2.2} />
        </button>
      </div>
      <div style={{ padding: "7px 10px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: "var(--fs-badge)", color: "var(--c-accent)", background: "var(--c-accent-bg-light)", borderRadius: 3, padding: "1px 5px", fontWeight: 700 }}>{t("block.filter.output_badge")}</span>
        <span title={block.command} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
          {block.command}
        </span>
      </div>
      <div style={{ overflow: "auto", minHeight: 0, padding: "6px 0", background: "var(--c-bg-1)" }}>
        {visibleLines.length === 0 ? (
          <div style={{ padding: "26px 12px", textAlign: "center", color: result.invalidRegex ? "var(--c-error)" : "var(--c-text-5)", fontSize: "var(--fs-secondary)" }}>
            {result.invalidRegex ? t("block.filter.regex_invalid") : t("block.filter.no_match")}
          </div>
        ) : (
          <>
            {visibleLines.map((line) => (
              <div
                key={line.index}
                style={{
                  display: "grid",
                  gridTemplateColumns: "54px minmax(0, 1fr)",
                  gap: 8,
                  padding: "1px 10px",
                  background: line.selected ? "var(--c-accent-bg-light)" : line.context ? "var(--c-bg-2)" : "transparent",
                  color: line.selected ? "var(--c-text-primary)" : "var(--c-text-3)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-meta)",
                  lineHeight: "18px",
                }}
              >
                <span style={{ color: "var(--c-text-5)", textAlign: "right", userSelect: "none" }}>{line.index + 1}</span>
                <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{line.text || " "}</span>
              </div>
            ))}
            {clipped && (
              <div style={{ padding: "6px 10px 2px 72px", color: "var(--c-text-5)", fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)" }}>
                {t("block.filter.clipped", { count: FILTER_RENDER_LIMIT })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
