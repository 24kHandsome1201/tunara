import { useState } from "react";
import type { TerminalCommandBlock } from "./useTerminalBlocks";

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckMiniIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ExitCodeBadge({ code, completed }: { code: number | undefined; completed: boolean }) {
  if (!completed) {
    return (
      <span style={{
        fontSize: "var(--fs-badge)",
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        color: "var(--c-accent)",
        background: "var(--c-accent-bg-light)",
        borderRadius: 3,
        padding: "0 4px",
        lineHeight: "14px",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
      }}>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: "currentColor", animation: "pulseDot 1.5s var(--ease-in-out) infinite" }} />
        运行
      </span>
    );
  }

  const ok = code === 0;
  return (
    <span style={{
      fontSize: "var(--fs-badge)",
      fontFamily: "var(--font-mono)",
      fontWeight: 700,
      color: ok ? "var(--c-success)" : "var(--c-error)",
      background: ok ? "var(--c-success-bg)" : "var(--c-error-bg)",
      borderRadius: 3,
      padding: "0 4px",
      lineHeight: "14px",
      flexShrink: 0,
    }}>
      {ok ? "✓" : code ?? "?"}
    </span>
  );
}

function CopyButton({ id, disabled, onCopy }: { id: string; disabled: boolean; onCopy: (id: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onCopy(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="hover-bg"
      title={disabled ? "命令运行中" : "复制输出"}
      disabled={disabled}
      style={{
        width: 22,
        height: 20,
        border: "none",
        borderRadius: "var(--r-btn)",
        background: "transparent",
        color: disabled ? "var(--c-text-6)" : copied ? "var(--c-success)" : "var(--c-text-5)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "color var(--duration-fast) var(--ease-smooth)",
      }}
    >
      {copied ? <CheckMiniIcon /> : <CopyIcon />}
    </button>
  );
}

interface TerminalBlocksBarProps {
  blocks: TerminalCommandBlock[];
  collapsedBlockIds: Record<string, true>;
  onCopy: (id: string) => void;
  onToggle: (id: string) => void;
}

export function TerminalBlocksBar({ blocks, collapsedBlockIds, onCopy, onToggle }: TerminalBlocksBarProps) {
  const visibleBlocks = blocks.slice(-5).reverse();
  if (visibleBlocks.length === 0) return null;

  return (
    <div style={{ minHeight: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 5, padding: "4px 8px 0", overflowX: "auto" }} className="no-scrollbar">
      {visibleBlocks.map((block) => {
        const collapsed = !!collapsedBlockIds[block.id];
        const completed = !!block.completedAt;
        const ok = completed && block.exitCode === 0;
        return (
          <div
            key={block.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              minWidth: 0,
              maxWidth: 280,
              border: `1px solid ${collapsed ? (ok ? "color-mix(in srgb, var(--c-success) 20%, var(--c-border-1))" : "color-mix(in srgb, var(--c-error) 20%, var(--c-border-1))") : "var(--c-border-1)"}`,
              background: collapsed ? "var(--c-bg-3)" : "var(--c-bg-1)",
              borderRadius: "var(--r-btn)",
              padding: "3px 4px 3px 8px",
              flexShrink: 0,
              transition: "border-color var(--duration-fast) var(--ease-smooth), background var(--duration-fast) var(--ease-smooth)",
            }}
          >
            <ExitCodeBadge code={block.exitCode} completed={completed} />
            <button
              onClick={() => onToggle(block.id)}
              title={block.command}
              style={{
                border: "none",
                background: "transparent",
                color: collapsed ? "var(--c-text-primary)" : "var(--c-text-3)",
                fontSize: "var(--fs-meta)",
                fontFamily: "var(--font-mono)",
                fontWeight: collapsed ? 600 : 400,
                cursor: "pointer",
                maxWidth: 180,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                padding: 0,
                transition: "color var(--duration-fast) var(--ease-smooth)",
              }}
            >
              {block.command}
            </button>
            <CopyButton id={block.id} disabled={!completed} onCopy={onCopy} />
          </div>
        );
      })}
    </div>
  );
}
