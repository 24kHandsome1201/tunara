// Sidebar — 左侧边栏（272px）
// 含：顶部分段按钮 / 搜索框 / 会话分组列表 / 底部设置+会话数

import { SessionCard } from "./SessionCard";
import { groupByDir, type Session } from "./types";

import { useState } from "react";

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewTerminal: () => void;
  onNewAgent: () => void;
  onOpenSettings: () => void;
}

/** 搜索放大镜 SVG */
function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a1a1aa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

/** 文件夹 SVG */
function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#b4b4bc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** 齿轮 SVG */
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** 目录分组头 */
function DirGroupHeader({ dir, count }: { dir: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 14px 4px",
      }}
    >
      <FolderIcon />
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          color: "var(--c-text-3)",
          flex: 1,
        }}
      >
        {dir}
      </span>
      {/* 计数胶囊 */}
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
    </div>
  );
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewTerminal,
  onNewAgent,
  onOpenSettings,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const filtered = search.trim()
    ? sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(search.toLowerCase()) ||
          s.dir.toLowerCase().includes(search.toLowerCase()),
      )
    : sessions;
  const groups = groupByDir(filtered);

  return (
    <div
      style={{
        width: "var(--w-sidebar)",
        background: "var(--c-bg-2-glass)",
        borderRight: "1px solid var(--c-border-1)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* 顶部分段按钮 */}
      <div style={{ padding: "10px 12px 8px" }}>
        <div
          style={{
            display: "flex",
            background: "var(--c-bg-white)",
            border: "1px solid var(--c-border-2)",
            borderRadius: "var(--r-card)",
            overflow: "hidden",
          }}
        >
          {/* 左段：新建终端（即时，无弹层） */}
          <button
            onClick={onNewTerminal}
            style={{
              flex: 1,
              padding: "7px 10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
            className="hover-bg"
          >
            <span style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-2)" }}>
              + 新建终端
            </span>
            <span
              style={{
                fontSize: "var(--fs-badge)",
                color: "var(--c-text-5)",
                fontFamily: "var(--font-mono)",
                marginLeft: 2,
              }}
            >
              ⌘T
            </span>
          </button>

          {/* 分隔线 */}
          <div style={{ width: 1, background: "var(--c-border-1)", flexShrink: 0 }} />

          {/* 右段：✦ Agent（打开弹层） */}
          <button
            onClick={onNewAgent}
            style={{
              flex: 1,
              padding: "7px 10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
            className="hover-accent-bg"
          >
            <span style={{ fontSize: 11, color: "var(--c-accent)" }}>✦</span>
            <span style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-accent)" }}>
              Agent
            </span>
          </button>
        </div>
      </div>

      {/* 搜索框 */}
      <div style={{ padding: "0 12px 8px" }}>
        <div
          style={{
            background: "var(--c-bg-3)",
            borderRadius: "var(--r-input)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 10px",
          }}
        >
          <SearchIcon />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话"
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: "var(--fs-body)",
              color: "var(--c-text-primary)",
              fontFamily: "var(--font-ui)",
            }}
          />
        </div>
      </div>

      {/* 会话列表（按目录分组，可滚动） */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 8px",
        }}
        className="no-scrollbar"
      >
        {Object.entries(groups).map(([dir, groupSessions]) => (
          <div key={dir} style={{ marginBottom: 8 }}>
            <DirGroupHeader dir={dir} count={groupSessions.length} />
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {groupSessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onClick={() => onSelectSession(s.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 底部：设置 + 会话数 */}
      <div
        style={{
          borderTop: "1px solid var(--c-border-1)",
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <button
          onClick={onOpenSettings}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: "3px 6px",
            borderRadius: "var(--r-btn)",
          }}
          className="hover-bg"
        >
          <GearIcon />
          <span style={{ fontSize: "var(--fs-body)", color: "var(--c-text-4)" }}>设置</span>
        </button>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "var(--fs-secondary)",
            color: "var(--c-text-5)",
          }}
        >
          {sessions.length} 个会话
        </span>
      </div>
    </div>
  );
}
