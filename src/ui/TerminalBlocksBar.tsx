import { useState } from "react";
import type { TerminalCommandBlock } from "@/modules/terminal/lib/terminal-blocks";
import { buildBlockContextMenuItems } from "@/modules/terminal/lib/terminal-blocks-menu";
import { ContextMenu } from "./ContextMenu";

function ExitCodeBadge({ code, completed }: { code: number | undefined; completed: boolean }) {
  if (!completed) {
    return (
      <span style={{
        fontSize: "var(--fs-meta)",
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        color: "var(--c-accent)",
        background: "var(--c-accent-bg-light)",
        borderRadius: 3,
        padding: "0 5px",
        lineHeight: "16px",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: "currentColor", animation: "pulseDot 1.5s var(--ease-in-out) infinite" }} />
        运行
      </span>
    );
  }

  const ok = code === 0;
  return (
    <span style={{
      fontSize: "var(--fs-meta)",
      fontFamily: "var(--font-mono)",
      fontWeight: 700,
      color: ok ? "var(--c-success)" : "var(--c-error)",
      background: ok ? "var(--c-success-bg)" : "var(--c-error-bg)",
      borderRadius: 3,
      padding: "0 5px",
      lineHeight: "16px",
      flexShrink: 0,
    }}>
      {ok ? "✓" : code ?? "?"}
    </span>
  );
}

type CopyBlockResult = boolean | Promise<boolean>;

interface TerminalBlocksBarProps {
  blocks: TerminalCommandBlock[];
  collapsedBlockIds: Record<string, true>;
  stickyBlock: TerminalCommandBlock | null;
  onCopyCommand: (id: string) => CopyBlockResult;
  onCopyCommandAndOutput: (id: string) => CopyBlockResult;
  onCopyOutput: (id: string) => CopyBlockResult;
  onFilterBlock: (block: TerminalCommandBlock) => void;
  onToggle: (id: string) => void;
  onReveal: (id: string) => void;
}

export function TerminalBlocksBar({ blocks, collapsedBlockIds, stickyBlock, onCopyCommand, onCopyCommandAndOutput, onCopyOutput, onFilterBlock, onToggle, onReveal }: TerminalBlocksBarProps) {
  const [contextMenu, setContextMenu] = useState<{
    block: TerminalCommandBlock;
    completed: boolean;
    collapsed: boolean;
    position: { x: number; y: number };
  } | null>(null);
  const visibleBlocks = blocks.slice(-5).reverse();
  if (visibleBlocks.length === 0) return null;

  const openContextMenu = (
    block: TerminalCommandBlock,
    completed: boolean,
    collapsed: boolean,
    position: { x: number; y: number },
  ) => {
    setContextMenu({ block, completed, collapsed, position });
  };

  const contextItems = contextMenu
    ? buildBlockContextMenuItems(contextMenu.block, contextMenu.completed, contextMenu.collapsed, {
        onCopyCommand,
        onCopyOutput,
        onCopyCommandAndOutput,
        onFilterBlock,
        onReveal,
        onToggle,
      })
    : [];

  return (
    <div style={{ minHeight: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 5, padding: "4px 8px 0", overflowX: "auto" }} className="no-scrollbar">
      {stickyBlock && (
        <div
          className="cmd-chip"
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(stickyBlock, !!stickyBlock.completedAt, !!collapsedBlockIds[stickyBlock.id], { x: e.clientX, y: e.clientY });
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            maxWidth: 300,
            border: "1px solid color-mix(in srgb, var(--c-accent) 28%, var(--c-border-1))",
            background: "var(--c-accent-bg-light)",
            borderRadius: "var(--r-btn)",
            padding: "3px 8px",
            flexShrink: 0,
            boxShadow: "var(--shadow-card)",
          }}
        >
          <span style={{
            fontSize: "var(--fs-meta)",
            color: "var(--c-accent)",
            fontWeight: 700,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            当前输出
          </span>
          <ExitCodeBadge code={stickyBlock.exitCode} completed={!!stickyBlock.completedAt} />
          <button
            onClick={() => onReveal(stickyBlock.id)}
            title={stickyBlock.command}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--c-text-primary)",
              fontSize: "var(--fs-meta)",
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              cursor: "pointer",
              maxWidth: 170,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: 0,
            }}
          >
            {stickyBlock.command}
          </button>
          <button
            type="button"
            className="cmd-chip-more"
            title="更多操作"
            aria-label="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openContextMenu(stickyBlock, !!stickyBlock.completedAt, !!collapsedBlockIds[stickyBlock.id], { x: rect.left, y: rect.bottom + 4 });
            }}
            style={{
              width: 18,
              height: 18,
              border: "none",
              background: "transparent",
              color: "var(--c-text-5)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              borderRadius: 4,
              flexShrink: 0,
              marginLeft: 1,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <circle cx="2" cy="6" r="1.1" />
              <circle cx="6" cy="6" r="1.1" />
              <circle cx="10" cy="6" r="1.1" />
            </svg>
          </button>
        </div>
      )}
      {visibleBlocks.map((block) => {
        const collapsed = !!collapsedBlockIds[block.id];
        const completed = !!block.completedAt;
        const ok = completed && block.exitCode === 0;
        return (
          <div
            key={block.id}
            className="cmd-chip"
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(block, completed, collapsed, { x: e.clientX, y: e.clientY });
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              minWidth: 0,
              maxWidth: 280,
              border: `1px solid ${collapsed ? (ok ? "color-mix(in srgb, var(--c-success) 20%, var(--c-border-1))" : "color-mix(in srgb, var(--c-error) 20%, var(--c-border-1))") : "var(--c-border-1)"}`,
              background: collapsed ? "var(--c-bg-3)" : "var(--c-bg-1)",
              borderRadius: "var(--r-btn)",
              padding: "3px 4px 3px 10px",
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
                maxWidth: 154,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                padding: 0,
                transition: "color var(--duration-fast) var(--ease-smooth)",
              }}
            >
              {block.command}
            </button>
            <button
              type="button"
              className="cmd-chip-more"
              title="更多操作"
              aria-label="更多操作"
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                openContextMenu(block, completed, collapsed, { x: rect.left, y: rect.bottom + 4 });
              }}
              style={{
                width: 18,
                height: 18,
                border: "none",
                background: "transparent",
                color: "var(--c-text-5)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                borderRadius: 4,
                flexShrink: 0,
                marginLeft: 1,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <circle cx="2" cy="6" r="1.1" />
                <circle cx="6" cy="6" r="1.1" />
                <circle cx="10" cy="6" r="1.1" />
              </svg>
            </button>
          </div>
        );
      })}
      {contextMenu && (
        <ContextMenu
          items={contextItems}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
