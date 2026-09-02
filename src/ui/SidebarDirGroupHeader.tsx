import type { KeyboardEvent, MouseEvent } from "react";
import { CloseIcon, SearchIcon } from "./shared";
import { CaretRight, FolderSimple, HardDrives, Icon, Plus } from "@/ui/icons";
import { useT } from "@/modules/i18n";
import type { SessionCue } from "@/modules/session/session-attention";
import { SessionCueDot } from "./SessionCueDot";

function FolderIcon() {
  return <Icon icon={FolderSimple} size={13} color="var(--c-text-6)" />;
}

function HostIcon() {
  return <Icon icon={HardDrives} size={13} color="var(--c-text-6)" />;
}

export function SidebarSearchIcon() {
  return <SearchIcon />;
}

export function DirGroupHeader({
  kind = "local",
  label,
  pathTitle,
  count,
  workspace,
  agentCount = 0,
  cue = null,
  collapsed,
  onToggleCollapse,
  onNewTerminal,
  onCloseAll,
  confirmClose,
  onContextMenu,
  onKeyDown,
}: {
  kind?: "local" | "ssh";
  label: string;
  pathTitle: string;
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
  cue?: SessionCue | null;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNewTerminal?: () => void;
  onCloseAll?: () => void;
  confirmClose?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const groupName = kind === "ssh" ? label : workspace?.repositoryName || label;
  const newTerminalLabel = kind === "ssh" ? t("sidebar.session.duplicate_host") : t("dir_group.new_terminal");
  const closeAllTitle = confirmClose
    ? t("session.close.all_running_hint")
    : kind === "ssh"
      ? t("session.close.all_host_title")
      : t("session.close.all_title");
  const headerContent = (
    <>
      {onToggleCollapse && (
        <Icon
          icon={CaretRight}
          size={10}
          weight="bold"
          color="var(--c-text-5)"
          style={{
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--dur-base) var(--ease-out)",
            flexShrink: 0,
          }}
        />
      )}
      {kind === "ssh" ? <HostIcon /> : <FolderIcon />}
      <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: workspace ? 2 : 0 }} title={pathTitle}>
        <span
          style={{
            fontSize: "var(--fs-meta)",
            fontWeight: workspace || kind === "ssh" ? 650 : 600,
            fontFamily: "var(--font-mono)",
            color: workspace || kind === "ssh" ? "var(--c-text-5)" : "var(--c-text-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            letterSpacing: workspace || kind === "ssh" ? "0.02em" : undefined,
            textAlign: "left",
          }}
        >
          {kind === "ssh" ? label : workspace ? workspace.repositoryName : label}
          {kind === "ssh" && (
            <span style={{ marginLeft: 5, color: "var(--c-text-6)", fontSize: "var(--fs-meta)", fontWeight: 600 }}>{t("workspace.ssh")}</span>
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
      <SessionCueDot cue={cue} />
      <span
        title={t("workspace.group_counts", { sessions: String(count), agents: String(agentCount) })}
        style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-4)",
          background: "var(--c-bg-3)",
          borderRadius: "var(--r-pill)",
          padding: "1px 6px",
          fontFamily: "var(--font-mono)",
        }}
      >
        {agentCount > 0 ? `${count} · ${t("workspace.agent_count_short", { count: agentCount })}` : count}
      </span>
    </>
  );

  return (
    <div
      className="dir-group-header"
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      role="group"
      aria-label={`${kind === "ssh" ? `${label}, ${t("workspace.ssh")}` : pathTitle}, ${t("workspace.group_counts", { sessions: String(count), agents: String(agentCount) })}`}
      tabIndex={0}
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
          title={collapsed ? t("dir_group.expand_named", { name: groupName }) : t("dir_group.collapse_named", { name: groupName })}
          aria-label={collapsed ? t("dir_group.expand_named", { name: groupName }) : t("dir_group.collapse_named", { name: groupName })}
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
          title={newTerminalLabel}
          aria-label={newTerminalLabel}
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
          <Icon icon={Plus} size={12} weight="bold" />
        </button>
      )}
      {onCloseAll && (
        <button
          type="button"
          className="dir-group-close hover-close"
          onClick={(e) => { e.stopPropagation(); onCloseAll(); }}
          title={closeAllTitle}
          aria-label={closeAllTitle}
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
