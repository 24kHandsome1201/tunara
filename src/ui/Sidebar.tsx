import { SessionCard } from "./SessionCard";
import { groupByDir, deriveTitle, type Session } from "./types";
import { useState, useRef, useCallback } from "react";
import { useSessionsStore } from "@/state/sessions";

interface DragState {
  draggingId: string;
  sourceDir: string;
  overIndex: number;
}

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

function DirGroupHeader({ dir, count, onNewTerminal }: { dir: string; count: number; onNewTerminal?: () => void }) {
  return (
    <div
      className="dir-group-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 14px 6px",
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
      {onNewTerminal && (
        <span
          role="button"
          tabIndex={0}
          className="dir-group-add hover-bg"
          onClick={(e) => { e.stopPropagation(); onNewTerminal(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onNewTerminal(); } }}
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
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const dragStartY = useRef(0);
  const dragStarted = useRef(false);
  const closeConfirmations = useSessionsStore((s) => s.closeConfirmations);
  const clearCloseConfirmation = useSessionsStore((s) => s.clearCloseConfirmation);
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

  const handleDragStart = useCallback((e: React.PointerEvent, sessionId: string, dir: string, index: number) => {
    dragStartY.current = e.clientY;
    dragStarted.current = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!dragStarted.current && Math.abs(ev.clientY - dragStartY.current) > 4) {
        dragStarted.current = true;
        const initial: DragState = { draggingId: sessionId, sourceDir: dir, overIndex: index };
        dragRef.current = initial;
        setDrag(initial);
      }
      if (!dragStarted.current) return;

      const container = el.closest("[data-dir-group]");
      if (!container) return;
      const cards = Array.from(container.querySelectorAll("[data-session-id]"));
      let closest = index;
      let minDist = Infinity;
      cards.forEach((card, i) => {
        const rect = card.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const dist = Math.abs(ev.clientY - mid);
        if (dist < minDist) { minDist = dist; closest = i; }
      });
      setDrag((prev) => {
        const next = prev ? { ...prev, overIndex: closest } : null;
        dragRef.current = next;
        return next;
      });
    };

    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const finalDrag = dragRef.current;
      if (dragStarted.current && finalDrag) {
        const current = useSessionsStore.getState().sessions;
        const fromIdx = current.filter((s) => s.dir === finalDrag.sourceDir).findIndex((s) => s.id === finalDrag.draggingId);
        if (fromIdx !== -1) {
          useSessionsStore.getState().reorderInGroup(finalDrag.sourceDir, fromIdx, finalDrag.overIndex);
        }
      }
      dragRef.current = null;
      setDrag(null);
      dragStarted.current = false;
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

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
        <div style={{ padding: "10px 12px 6px", display: "flex", gap: 6 }}>
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
      <div style={{ padding: "6px 12px" }}>
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
            transition: "border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease",
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
          <div key={dir} style={{ marginBottom: 6 }} data-dir-group={dir}>
            <DirGroupHeader dir={dir} count={groupSessions.length} onNewTerminal={() => useSessionsStore.getState().newTerminalInDir(dir)} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {groupSessions.map((s, idx) => {
                const isDragging = drag?.draggingId === s.id;
                const showIndicator = drag?.sourceDir === dir && drag.overIndex === idx && drag.draggingId !== s.id;
                return (
                  <div key={s.id} data-session-id={s.id}>
                    {showIndicator && (
                      <div style={{ height: 2, background: "var(--c-accent)", borderRadius: 1, margin: "0 10px 2px" }} />
                    )}
                    <div
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).closest(".session-card-close") || (e.target as HTMLElement).closest(".hover-close")) return;
                        handleDragStart(e, s.id, dir, idx);
                      }}
                      style={{
                        opacity: isDragging ? 0.3 : 1,
                        transition: "opacity 120ms ease",
                        touchAction: "none",
                      }}
                    >
                      <SessionCard
                        session={s}
                        active={s.id === activeSessionId}
                        confirmClose={!!closeConfirmations[s.id]}
                        onClick={() => { if (!dragStarted.current) onSelectSession(s.id); }}
                        onClose={onCloseSession ? () => onCloseSession(s.id) : undefined}
                        onClearCloseConfirm={() => clearCloseConfirmation(s.id)}
                      />
                    </div>
                  </div>
                );
              })}
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
