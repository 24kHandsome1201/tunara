// Titlebar — 顶部标题栏（48px）
// 含：红绿灯占位 / 折叠侧栏按钮 / Tab 区 / 审查开关 / 铃铛+角标
// data-tauri-drag-region 只放可拖拽空白区，所有交互元素不带该属性

import { useState } from "react";
import { type Session, deriveTitle } from "./types";

/** Tauri 拖拽区 CSS 扩展（WebkitAppRegion 不在标准 CSSProperties 中） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DragStyle = React.CSSProperties & { WebkitAppRegion?: string; [key: string]: any };

interface TitlebarProps {
  sessions: Session[];
  activeSessionId: string;
  panelVisible: boolean;
  unreadCount: number;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onToggleNotif: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onOpenSettings: () => void;
}

/** 面板折叠 SVG 图标 */
function PanelLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill="var(--c-accent)" fillOpacity="0.3" />
    </svg>
  );
}

/** 齿轮 SVG */
function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 铃铛 SVG */
function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function TabButton({ session, isActive, label, onSelect, onClose }: { session: Session; isActive: boolean; label: string; onSelect: () => void; onClose: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "5px 13px",
        borderRadius: "var(--r-btn)",
        border: "none",
        background: isActive ? "var(--c-bg-hover)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        position: "relative",
      }}
    >
      {isActive && (
        <div style={{ position: "absolute", bottom: 0, left: 4, right: 4, height: 2, background: "var(--c-accent)", borderRadius: 1 }} />
      )}
      <span style={{ fontSize: 12, fontWeight: 500, color: isActive ? "var(--c-text-primary)" : "var(--c-text-4)", fontFamily: "var(--font-ui)" }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: isActive ? "var(--c-text-5)" : "var(--c-text-7)", fontFamily: "var(--font-mono)" }}>
        ⎇ {session.branch.length > 14 ? session.branch.slice(0, 14) + "…" : session.branch}
      </span>
      {hovered && (
        <span
          role="button"
          tabIndex={0}
          title="关闭"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClose(); } }}
          style={{
            width: 15, height: 15, borderRadius: 4, display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 13, lineHeight: 1, flexShrink: 0, marginLeft: 1,
          }}
          className="hover-close"
        >
          ×
        </span>
      )}
    </button>
  );
}

export function Titlebar({
  sessions,
  activeSessionId,
  panelVisible,
  unreadCount,
  onToggleSidebar,
  onTogglePanel,
  onToggleNotif,
  onSelectSession,
  onCloseSession,
  onOpenSettings,
}: TitlebarProps) {
  const tabSessions = sessions;

  function tabLabel(s: Session): string {
    const { primary } = deriveTitle(s);
    return primary.length > 24 ? primary.slice(0, 24) + "…" : primary;
  }

  return (
    <div
      style={{
        height: "var(--h-titlebar)",
        background: "var(--c-bg-1)",
        borderBottom: "1px solid var(--c-border-1)",
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        position: "relative",
        WebkitAppRegion: "drag",
      } as DragStyle}
      data-tauri-drag-region
    >
      {/* 左侧区：macOS 原生红绿灯由窗口层渲染，这里只留出避让空间 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        <div style={{ width: 96, flexShrink: 0 }} />
        <button
          onClick={onToggleSidebar}
          title="折叠侧边栏"
          style={{
            width: 28,
            height: 28,
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
          <PanelLeftIcon />
        </button>
      </div>

      {/* Tab 区 — 紧贴折叠按钮右侧，可横向滚动 */}
      <div
        className="no-scrollbar"
        style={{
          display: "flex",
          alignItems: "center",
          height: "100%",
          gap: 0,
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {tabSessions.map((s) => (
          <TabButton
            key={s.id}
            session={s}
            isActive={s.id === activeSessionId}
            label={tabLabel(s)}
            onSelect={() => onSelectSession(s.id)}
            onClose={() => onCloseSession(s.id)}
          />
        ))}

      </div>

      {/* 右侧簇：设置 + 审查开关 + 铃铛 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingRight: 14,
          flexShrink: 0,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {/* 设置 */}
        <button
          onClick={onOpenSettings}
          title="设置 ⌘,"
          style={{
            width: 28,
            height: 28,
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
          <GearIcon />
        </button>

        {/* 审查面板开关 */}
        <button
          onClick={onTogglePanel}
          title={panelVisible ? "隐藏审查面板" : "显示审查面板"}
          style={{
            width: 28,
            height: 28,
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
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <rect x="9" y="1.5" width="5.5" height="13" rx="2" fill={panelVisible ? "currentColor" : "none"} fillOpacity="0.3" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>

        {/* 铃铛 + 未读角标 */}
        <button
          onClick={onToggleNotif}
          title="通知中心"
          style={{
            width: 28,
            height: 28,
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
