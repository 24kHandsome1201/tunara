import { useState } from "react";
import type { TerminalCommandBlock } from "@/modules/terminal/lib/terminal-blocks";
import { buildBlockContextMenuItems } from "@/modules/terminal/lib/terminal-blocks-menu";
import { useT } from "@/modules/i18n";
import { hasTrueRecordKey } from "@/state/record-keys";
import { ContextMenu, type MenuEntry } from "./ContextMenu";

function ExitCodeBadge({ code, completed }: { code: number | undefined; completed: boolean }) {
  const t = useT();
  if (!completed) {
    return (
      <span style={{
        fontSize: "var(--fs-meta)",
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        color: "var(--c-accent)",
        background: "var(--c-accent-bg-light)",
        borderRadius: "var(--r-badge-sm)",
        padding: "0 5px",
        lineHeight: "16px",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}>
        <span style={{ width: 4, height: 4, borderRadius: "50%", background: "currentColor", animation: "loadPulse 1.5s var(--ease-in-out) infinite" }} />
        {t("block.status.running")}
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
      borderRadius: "var(--r-badge-sm)",
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
  const t = useT();
  const [contextMenu, setContextMenu] = useState<{
    block: TerminalCommandBlock;
    completed: boolean;
    collapsed: boolean;
    position: { x: number; y: number };
  } | null>(null);
  const [historyMenu, setHistoryMenu] = useState<{ x: number; y: number } | null>(null);
  const historyCandidates = blocks.filter((block) => block.id !== stickyBlock?.id);
  const visibleBlocks = historyCandidates.slice(-5).reverse();
  const hiddenBlockCount = Math.max(0, historyCandidates.length - 5);
  const hiddenBlocks = historyCandidates.slice(0, hiddenBlockCount).reverse();
  if (historyCandidates.length === 0 && !stickyBlock) return null;

  const openContextMenu = (
    block: TerminalCommandBlock,
    completed: boolean,
    collapsed: boolean,
    position: { x: number; y: number },
  ) => {
    setHistoryMenu(null);
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
  const historyItems: MenuEntry[] = hiddenBlocks.map((block) => {
    const prefix = !block.completedAt ? "•" : block.exitCode === 0 ? "✓" : String(block.exitCode ?? "?");
    return {
      id: `block-history:${block.id}`,
      label: `${prefix}  ${block.command}`,
      icon: "terminal",
      action: () => onReveal(block.id),
    };
  });

  return (
    <div style={{ minHeight: 32, flexShrink: 0, display: "flex", alignItems: "center", gap: 5, padding: "4px 8px 0", overflowX: "auto" }} className="no-scrollbar">
      {stickyBlock && (
        <div
          className="cmd-chip"
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(stickyBlock, !!stickyBlock.completedAt, hasTrueRecordKey(collapsedBlockIds, stickyBlock.id), { x: e.clientX, y: e.clientY });
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
            {t("block.current_output")}
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
            title={t("common.more_actions")}
            aria-label={t("common.more_actions")}
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openContextMenu(stickyBlock, !!stickyBlock.completedAt, hasTrueRecordKey(collapsedBlockIds, stickyBlock.id), { x: rect.left, y: rect.bottom + 4 });
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
        const collapsed = hasTrueRecordKey(collapsedBlockIds, block.id);
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
              title={t("common.more_actions")}
              aria-label={t("common.more_actions")}
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
      {hiddenBlocks.length > 0 && (
        <button
          type="button"
          className="cmd-chip hover-bg"
          aria-label={t("block.history.more", { count: hiddenBlocks.length })}
          title={t("block.history.more", { count: hiddenBlocks.length })}
          onClick={(event) => {
            setContextMenu(null);
            const rect = event.currentTarget.getBoundingClientRect();
            setHistoryMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
          style={{
            height: 24,
            padding: "0 8px",
            border: "1px solid var(--c-border-1)",
            borderRadius: "var(--r-btn)",
            background: "var(--c-bg-1)",
            color: "var(--c-text-4)",
            fontSize: "var(--fs-meta)",
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {t("block.history.more", { count: hiddenBlocks.length })}
        </button>
      )}
      {contextMenu && (
        <ContextMenu
          items={contextItems}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
      {historyMenu && (
        <ContextMenu
          items={historyItems}
          position={historyMenu}
          onClose={() => setHistoryMenu(null)}
        />
      )}
    </div>
  );
}
