import { SessionCard } from "./SessionCard";
import { groupByDir, deriveTitle, type Session } from "./types";
import { useState } from "react";

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewTerminal?: () => void;
  onCloseSession?: (id: string) => void;
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

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
    </div>
  );
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewTerminal,
  onCloseSession,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => {
        const { primary, subtitle } = deriveTitle(s);
        return (
          primary.toLowerCase().includes(q) ||
          subtitle.toLowerCase().includes(q) ||
          s.dir.toLowerCase().includes(q)
        );
      })
    : sessions;
  const groups = groupByDir(filtered);

  return (
    <div
      style={{
        width: "100%",
        background: "var(--c-bg-2-glass)",
        borderRight: "1px solid var(--c-border-1)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {onNewTerminal && (
        <div style={{ padding: "10px 12px 4px", display: "flex", gap: 6 }}>
          <button
            onClick={onNewTerminal}
            style={{
              flex: 1,
              padding: "7px 10px",
              border: "1px solid var(--c-border-2)",
              borderRadius: "var(--r-card)",
              background: "var(--c-bg-white)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
            className="hover-bg"
          >
            <span style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-2)" }}>
              + 终端
            </span>
            <span
              style={{
                fontSize: "var(--fs-badge)",
                color: "var(--c-text-5)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ⌘T
            </span>
          </button>
        </div>
      )}

      {/* 搜索框 */}
      <div style={{ padding: "8px 12px" }}>
        <div
          className="sidebar-search"
          style={{
            background: "var(--c-bg-3)",
            borderRadius: "var(--r-input)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 10px",
            border: "1px solid transparent",
            transition: "border-color var(--duration-fast) ease",
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

      {/* 会话列表 */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 8px",
        }}
        className="no-scrollbar"
      >
        {Object.entries(groups).map(([dir, groupSessions]) => (
          <div key={dir} style={{ marginBottom: 6 }}>
            <DirGroupHeader dir={dir} count={groupSessions.length} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {groupSessions.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onClick={() => onSelectSession(s.id)}
                  onClose={onCloseSession ? () => onCloseSession(s.id) : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 底部：会话数 */}
      <div
        style={{
          borderTop: "1px solid var(--c-border-1)",
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <span
          style={{
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
