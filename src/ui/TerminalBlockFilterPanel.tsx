import { useMemo, useState } from "react";
import {
  filterTerminalBlockOutput,
  formatTerminalBlockFilterText,
} from "@/modules/terminal/lib/terminal-block-filter";
import { CloseIcon, SearchIcon } from "./shared";
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
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [invert, setInvert] = useState(false);
  const [contextLines, setContextLines] = useState(0);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    // 与 sheetOut keyframe 时长保持一致（--duration-fast = 120ms）
    setTimeout(onClose, 120);
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
    ? "正则错误"
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
          placeholder="筛选块输出…"
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
        <ToggleButton active={regex} label=".*" title="正则表达式" onClick={() => setRegex((value) => !value)} />
        <ToggleButton active={caseSensitive} label="Aa" title="区分大小写" onClick={() => setCaseSensitive((value) => !value)} />
        <ToggleButton active={invert} label="≠" title="反选匹配" onClick={() => setInvert((value) => !value)} />
        <input
          value={contextLines}
          type="number"
          min={0}
          max={10}
          title="上下文行"
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
            await navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }).catch(() => {});
          }}
          title="复制筛选结果"
          className="hover-bg"
          style={{ ...ICON_BUTTON_STYLE, color: copied ? "var(--c-success)" : "var(--c-text-5)" }}
        >
          {copied ? "✓" : copyIcon()}
        </button>
        <button onClick={requestClose} title="关闭 Esc" aria-label="关闭" className="hover-bg" style={ICON_BUTTON_STYLE}>
          <CloseIcon size={12} strokeWidth={2.2} />
        </button>
      </div>
      <div style={{ padding: "7px 10px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: "var(--fs-badge)", color: "var(--c-accent)", background: "var(--c-accent-bg-light)", borderRadius: 3, padding: "1px 5px", fontWeight: 700 }}>块输出</span>
        <span title={block.command} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
          {block.command}
        </span>
      </div>
      <div style={{ overflow: "auto", minHeight: 0, padding: "6px 0", background: "var(--c-bg-1)" }}>
        {visibleLines.length === 0 ? (
          <div style={{ padding: "26px 12px", textAlign: "center", color: result.invalidRegex ? "var(--c-error)" : "var(--c-text-5)", fontSize: "var(--fs-secondary)" }}>
            {result.invalidRegex ? "正则表达式无效" : "没有匹配行"}
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
                仅显示前 {FILTER_RENDER_LIMIT} 行
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
