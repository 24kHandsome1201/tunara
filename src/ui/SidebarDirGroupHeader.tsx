import type { MouseEvent } from "react";
import { CloseIcon, SearchIcon } from "./shared";
import { useT } from "@/modules/i18n";

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function SidebarSearchIcon() {
  return <SearchIcon />;
}

export function DirGroupHeader({
  dir,
  count,
  workspace,
  agentCount = 0,
  collapsed,
  onToggleCollapse,
  onNewTerminal,
  onCloseAll,
  confirmClose,
  onContextMenu,
}: {
  dir: string;
  count: number;
  workspace?: {
    repositoryName: string;
    worktreeName: string;
    branch?: string;
    detached: boolean;
    dirtyFiles?: number;
    ahead?: number;
    behind?: number;
    available: boolean;
    transport: "local" | "ssh";
  };
  agentCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNewTerminal?: () => void;
  onCloseAll?: () => void;
  confirmClose?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const t = useT();
  const headerContent = (
    <>
      {onToggleCollapse && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--c-text-5)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--duration-normal) var(--ease-out-back)",
            flexShrink: 0,
          }}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      )}
      <FolderIcon />
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: workspace ? 2 : 0 }} title={dir}>
        <span
          style={{
            fontSize: workspace ? "var(--fs-badge)" : "var(--fs-meta)",
            fontWeight: workspace ? 650 : 600,
            fontFamily: "var(--font-mono)",
            color: workspace ? "var(--c-text-5)" : "var(--c-text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: workspace ? "0.02em" : undefined,
            textAlign: "left",
          }}
        >
          {workspace ? workspace.repositoryName : dir.split("/").pop() || dir}
          {workspace?.transport === "ssh" && (
            <span style={{ marginLeft: 5, color: "var(--c-text-6)", fontSize: "var(--fs-badge)", fontWeight: 600 }}>SSH</span>
          )}
        </span>
        {workspace && (
          <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
            <span aria-hidden="true" style={{ color: "var(--c-text-6)" }}>└</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workspace.worktreeName}</span>
            <span style={{ color: "var(--c-text-6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {workspace.detached ? t("workspace.detached_short") : workspace.branch}
            </span>
            {(workspace.ahead ?? 0) > 0 && <span style={{ color: "var(--c-text-5)" }}>↑{workspace.ahead}</span>}
            {(workspace.behind ?? 0) > 0 && <span style={{ color: "var(--c-text-5)" }}>↓{workspace.behind}</span>}
            <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: "50%", background: !workspace.available ? "var(--c-error)" : workspace.dirtyFiles === undefined ? "var(--c-text-6)" : workspace.dirtyFiles > 0 ? "var(--c-warning)" : "var(--c-success)", flexShrink: 0 }} />
          </span>
        )}
      </span>
      <span
        title={t("workspace.group_counts", { sessions: String(count), agents: String(agentCount) })}
        style={{
          fontSize: "var(--fs-badge)",
          color: "var(--c-text-4)",
          background: "var(--c-bg-3)",
          borderRadius: "var(--r-pill)",
          padding: "1px 6px",
          fontFamily: "var(--font-mono)",
        }}
      >
        {agentCount > 0 ? `${count} · ${agentCount}A` : count}
      </span>
    </>
  );

  return (
    <div
      className="dir-group-header"
      onContextMenu={onContextMenu}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
      }}
    >
      {/* 折叠切换用真实 button（容器不再 role=button 嵌套按钮），
          aria-expanded 播报折叠状态 */}
      {onToggleCollapse ? (
        <button
          type="button"
          className="dir-group-toggle"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          title={collapsed ? t("dir_group.expand") : t("dir_group.collapse")}
          aria-label={collapsed ? t("dir_group.expand") : t("dir_group.collapse")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            font: "inherit",
            color: "inherit",
          }}
        >
          {headerContent}
        </button>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
          {headerContent}
        </div>
      )}
      {onNewTerminal && (
        <button
          type="button"
          className="dir-group-add hover-bg"
          onClick={(e) => { e.stopPropagation(); onNewTerminal(); }}
          title={t("dir_group.new_terminal")}
          aria-label={t("dir_group.new_terminal")}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--c-text-5)",
            padding: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
      {onCloseAll && (
        <button
          type="button"
          className="dir-group-close hover-close"
          onClick={(e) => { e.stopPropagation(); onCloseAll(); }}
          title={confirmClose ? t("session.close.all_running_hint") : t("session.close.all_title")}
          aria-label={confirmClose ? t("session.close.all_running_hint") : t("session.close.all_title")}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            border: "none",
            background: "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: confirmClose ? "var(--c-error)" : "var(--c-text-5)",
            opacity: confirmClose ? 1 : undefined,
            padding: 0,
          }}
        >
          <CloseIcon size={12} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}
