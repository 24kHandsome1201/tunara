import type { MouseEvent } from "react";
import { CloseIcon, SearchIcon } from "./shared";

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
  collapsed,
  onToggleCollapse,
  onNewTerminal,
  onCloseAll,
  confirmClose,
  onContextMenu,
}: {
  dir: string;
  count: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNewTerminal?: () => void;
  onCloseAll?: () => void;
  confirmClose?: boolean;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  return (
    <div
      className="dir-group-header"
      role={onToggleCollapse ? "button" : undefined}
      tabIndex={onToggleCollapse ? 0 : undefined}
      onClick={onToggleCollapse}
      onKeyDown={(e) => {
        if (onToggleCollapse && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onToggleCollapse();
        }
      }}
      title={onToggleCollapse ? (collapsed ? "展开" : "折叠") : undefined}
      onContextMenu={onContextMenu}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 9px",
        cursor: onToggleCollapse ? "pointer" : undefined,
      }}
    >
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
          style={{
            transform: collapsed ? "none" : "rotate(90deg)",
            transition: "transform var(--duration-fast) ease",
            flexShrink: 0,
          }}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      )}
      <FolderIcon />
      <span
        style={{
          fontSize: "var(--fs-meta)",
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          color: "var(--c-text-3)",
          flex: 1,
        }}
      >
        {dir}
      </span>
      <span
        style={{
          fontSize: "var(--fs-badge)",
          color: "var(--c-text-4)",
          background: "var(--c-bg-3)",
          borderRadius: "var(--r-pill)",
          padding: "1px 6px",
          fontFamily: "var(--font-mono)",
        }}
      >
        {count}
      </span>
      {onNewTerminal && (
        <span
          role="button"
          tabIndex={0}
          className="dir-group-add hover-bg"
          onClick={(e) => { e.stopPropagation(); onNewTerminal(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onNewTerminal(); } }}
          title="在此目录新建终端"
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--c-text-5)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </span>
      )}
      {onCloseAll && (
        <span
          role="button"
          tabIndex={0}
          className="dir-group-close hover-close"
          onClick={(e) => { e.stopPropagation(); onCloseAll(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onCloseAll(); } }}
          title={confirmClose ? "进程运行中，再次点击关闭全部" : "关闭此目录全部会话"}
          style={{
            width: 18,
            height: 18,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: confirmClose ? "var(--c-error)" : "var(--c-text-5)",
            opacity: confirmClose ? 1 : undefined,
          }}
        >
          <CloseIcon size={12} strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}
