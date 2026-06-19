// Titlebar — 顶部标题栏（48px）
// 含：红绿灯占位 / 折叠侧栏按钮 / Tab 区 / 审查开关 / 铃铛+角标
// data-tauri-drag-region 只放可拖拽空白区，所有交互元素不带该属性

import { type Session } from "./types";

/** Tauri 拖拽区 CSS 扩展（WebkitAppRegion 不在标准 CSSProperties 中） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DragStyle = React.CSSProperties & { WebkitAppRegion?: string; [key: string]: any };

interface TitlebarProps {
  sessions: Session[];
  activeSessionId: string;
  sidebarVisible: boolean;
  panelVisible: boolean;
  notifOpen: boolean;
  unreadCount: number;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onToggleNotif: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewAgent: () => void;
}

/** 面板折叠 SVG 图标 */
function PanelLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      {/* 外框 */}
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="#71717a" strokeWidth="1.2" />
      {/* 左栏小块（琥珀色半透明填充） */}
      <rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill="#c2683c" fillOpacity="0.3" />
    </svg>
  );
}

/** 铃铛 SVG */
function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function Titlebar({
  sessions,
  activeSessionId,
  sidebarVisible: _sidebarVisible,
  panelVisible,
  notifOpen: _notifOpen,
  unreadCount,
  onToggleSidebar,
  onTogglePanel,
  onToggleNotif,
  onSelectSession,
  onCloseSession,
  onNewAgent,
}: TitlebarProps) {
  const tabSessions = sessions;

  const dirCounts = new Map<string, number>();
  tabSessions.forEach((s) => {
    if (s.kind === "shell") {
      const label = s.dir.split("/").pop() ?? s.dir;
      dirCounts.set(label, (dirCounts.get(label) ?? 0) + 1);
    }
  });
  const shellCounters = new Map<string, number>();
  function tabLabel(s: Session): string {
    if (s.kind === "agent") return s.title;
    const base = s.dir.split("/").pop() ?? s.dir;
    if ((dirCounts.get(base) ?? 0) > 1) {
      const idx = (shellCounters.get(base) ?? 0) + 1;
      shellCounters.set(base, idx);
      return `${base} (${idx})`;
    }
    return base;
  }

  return (
    <div
      style={{
        height: "var(--h-titlebar)",
        background: "var(--c-bg-1-glass)",
        borderBottom: "1px solid var(--c-border-1)",
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        position: "relative",
        WebkitAppRegion: "drag",
      } as DragStyle}
      data-tauri-drag-region
    >
      {/* 红绿灯占位区（titleBarStyle Overlay 时系统红绿灯浮在这里） */}
      <div
        style={{
          width: 72,
          flexShrink: 0,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      />

      {/* 折叠侧栏按钮 */}
      <button
        onClick={onToggleSidebar}
        title="折叠侧边栏"
        style={{
          width: 28,
          height: 24,
          borderRadius: "var(--r-btn)",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginRight: 6,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
        className="hover-bg"
      >
        <PanelLeftIcon />
      </button>

      {/* Tab 区 — 紧贴折叠按钮右侧，可横向滚动 */}
      <div
        className="no-scrollbar"
        style={{
          display: "flex",
          alignItems: "flex-end",
          height: "100%",
          gap: 0,
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {tabSessions.map((s) => {
          const isActive = s.id === activeSessionId;
          return (
            <button
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              style={{
                padding: "7px 13px 8px",
                borderRadius: "8px 8px 0 0",
                border: isActive ? "1px solid var(--c-border-2)" : "1px solid transparent",
                borderBottom: isActive ? "1px solid var(--c-bg-white)" : "none",
                background: isActive ? "var(--c-bg-white)" : "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 5,
                flexShrink: 0,
                position: "relative",
                marginBottom: isActive ? -1 : 0,
              }}
            >
              {/* 激活标签顶部 2px 橘色线 */}
              {isActive && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: "var(--c-accent)",
                    borderRadius: "8px 8px 0 0",
                  }}
                />
              )}
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: isActive ? "var(--c-text-primary)" : "var(--c-text-4)",
                  fontFamily: "var(--font-ui)",
                }}
              >
                {tabLabel(s)}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: isActive ? "var(--c-text-5)" : "var(--c-text-7)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                ⎇ {s.branch.length > 14 ? s.branch.slice(0, 14) + "…" : s.branch}
              </span>
              <span
                role="button"
                tabIndex={0}
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseSession(s.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    onCloseSession(s.id);
                  }
                }}
                style={{
                  width: 15,
                  height: 15,
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  lineHeight: 1,
                  color: "var(--c-text-5)",
                  flexShrink: 0,
                  marginLeft: 1,
                }}
                className="hover-close"
              >
                ×
              </span>
            </button>
          );
        })}

        {/* + 新建 Agent 按钮 */}
        <button
          onClick={onNewAgent}
          title="新建 Agent"
          style={{
            width: 28,
            height: 24,
            marginBottom: 4,
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            color: "var(--c-text-4)",
            flexShrink: 0,
          }}
          className="hover-bg"
        >
          +
        </button>
      </div>

      {/* 右侧簇：审查开关 + 铃铛 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginLeft: "auto",
          paddingRight: 16,
          flexShrink: 0,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {/* 审查面板开关 */}
        <button
          onClick={onTogglePanel}
          title={panelVisible ? "隐藏审查面板" : "显示审查面板"}
          style={{
            width: 28,
            height: 24,
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          className="hover-bg"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="#71717a" strokeWidth="1.2" />
            <rect x="9" y="1.5" width="5.5" height="13" rx="2" fill={panelVisible ? "#71717a" : "none"} fillOpacity="0.3" stroke="#71717a" strokeWidth="1.2" />
          </svg>
        </button>

        {/* 铃铛 + 未读角标 */}
        <button
          onClick={onToggleNotif}
          title="通知中心"
          style={{
            width: 28,
            height: 24,
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
          }}
          className="hover-bg"
        >
          <BellIcon />
          {unreadCount > 0 && (
            <div
              style={{
                position: "absolute",
                top: 1,
                right: 1,
                minWidth: 14,
                height: 14,
                borderRadius: "var(--r-pill)",
                background: "var(--c-error)",
                color: "#fff",
                fontSize: "var(--fs-badge)",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0 3px",
              }}
            >
              {unreadCount}
            </div>
          )}
        </button>
      </div>
    </div>
  );
}
