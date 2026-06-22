import type { TerminalCommandBlock } from "./useTerminalBlocks";

interface TerminalBlocksBarProps {
  blocks: TerminalCommandBlock[];
  collapsedBlockIds: Record<string, true>;
  onCopy: (id: string) => void;
  onToggle: (id: string) => void;
}

export function TerminalBlocksBar({ blocks, collapsedBlockIds, onCopy, onToggle }: TerminalBlocksBarProps) {
  const visibleBlocks = blocks.filter((block) => block.completedAt).slice(-5).reverse();
  if (visibleBlocks.length === 0) return null;

  return (
    <div style={{ minHeight: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "4px 8px 0", overflowX: "auto" }} className="no-scrollbar">
      {visibleBlocks.map((block) => {
        const collapsed = !!collapsedBlockIds[block.id];
        return (
          <div key={block.id} style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, maxWidth: 280, border: "1px solid var(--c-border-1)", background: collapsed ? "var(--c-bg-3)" : "var(--c-bg-1)", borderRadius: "var(--r-btn)", padding: "3px 4px 3px 8px", flexShrink: 0 }}>
            <button
              onClick={() => onToggle(block.id)}
              title={block.command}
              style={{ border: "none", background: "transparent", color: collapsed ? "var(--c-accent)" : "var(--c-text-3)", fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", cursor: "pointer", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: 0 }}
            >
              {block.command}
            </button>
            <span style={{ fontSize: "var(--fs-badge)", color: block.exitCode === 0 ? "var(--c-success)" : "var(--c-error)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
              {block.exitCode === 0 ? "0" : block.exitCode}
            </span>
            <button onClick={() => onCopy(block.id)} className="hover-bg" style={{ width: 22, height: 20, border: "none", borderRadius: "var(--r-btn)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-badge)", cursor: "pointer", flexShrink: 0 }}>
              复制
            </button>
          </div>
        );
      })}
    </div>
  );
}
