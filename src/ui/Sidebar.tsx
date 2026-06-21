import { SessionCard } from "./SessionCard";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { groupByDir, deriveTitle, type Session } from "./types";
import { DirGroupHeader, SidebarSearchIcon } from "./SidebarDirGroupHeader";
import { useState, useRef, useCallback } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openInEditor } from "@/modules/editor/open";

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

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewTerminal,
  onCloseSession,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const dragRef = useRef<DragState | null>(null);
  const dragStartY = useRef(0);
  const dragStarted = useRef(false);
  const closeConfirmations = useSessionsStore((s) => s.closeConfirmations);
  const dirCloseConfirmations = useSessionsStore((s) => s.dirCloseConfirmations);
  const collapsedDirs = useUIStore((s) => s.collapsedDirs);
  const toggleDirCollapsed = useUIStore((s) => s.toggleDirCollapsed);
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
  const canReorder = q.length === 0;
  const groupEntries = Object.entries(groups);
  const visibleSessionIds = groupEntries.flatMap(([dir, groupSessions]) =>
    !!collapsedDirs[dir] && !q ? [] : groupSessions.map((s) => s.id)
  );
  const tabbableSessionId = visibleSessionIds.includes(activeSessionId) ? activeSessionId : visibleSessionIds[0] ?? null;

  const focusSessionCard = useCallback((sessionId: string) => {
    requestAnimationFrame(() => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-session-card-id]")).find(
        (el) => el.dataset.sessionCardId === sessionId,
      );
      card?.focus();
      card?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const handleSessionKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>, sessionId: string) => {
    const currentIndex = visibleSessionIds.indexOf(sessionId);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (e.key === "ArrowDown") nextIndex = Math.min(currentIndex + 1, visibleSessionIds.length - 1);
    else if (e.key === "ArrowUp") nextIndex = Math.max(currentIndex - 1, 0);
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = visibleSessionIds.length - 1;
    else return;

    const nextId = visibleSessionIds[nextIndex];
    if (!nextId) return;
    e.preventDefault();
    onSelectSession(nextId);
    focusSessionCard(nextId);
  }, [focusSessionCard, onSelectSession, visibleSessionIds]);

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

    const cleanup = (ev: PointerEvent) => {
      if (el.hasPointerCapture(ev.pointerId)) {
        el.releasePointerCapture(ev.pointerId);
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
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
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
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
      aria-label="会话侧栏"
    >
      {onNewTerminal && (
        <div style={{ padding: "8px 12px 6px" }}>
          <button
            onClick={onNewTerminal}
            style={{
              width: "100%",
              padding: "6px 10px",
              border: "none",
              borderRadius: "var(--r-btn)",
              background: "var(--c-accent-bg-soft)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              transition: "background var(--duration-fast) ease",
            }}
            className="hover-accent-bg"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-accent)" }}>
              新建终端
            </span>
            <span
              style={{
                fontSize: "var(--fs-badge)",
                color: "var(--c-text-5)",
                fontFamily: "var(--font-mono)",
                background: "var(--c-bg-3)",
                borderRadius: 4,
                padding: "1px 5px",
                marginLeft: "auto",
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
          <SidebarSearchIcon />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
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
        className="no-scrollbar scroll-fade-y scroll-fade-sidebar"
        role="list"
        aria-label="会话列表"
      >
        {filtered.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
            {q ? "无匹配会话" : "暂无会话"}
          </div>
        )}

        {groupEntries.map(([dir, groupSessions]) => {
          const collapsed = !!collapsedDirs[dir] && !q;
          return (
          <div key={dir} style={{ marginBottom: 6 }} data-dir-group={dir}>
            <DirGroupHeader
              dir={dir}
              count={groupSessions.length}
              collapsed={collapsed}
              onToggleCollapse={() => toggleDirCollapsed(dir)}
              onNewTerminal={() => useSessionsStore.getState().newTerminalInDir(dir)}
              onCloseAll={() => useSessionsStore.getState().closeSessionsInDir(dir)}
              confirmClose={!!dirCloseConfirmations[dir]}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({
                  position: { x: e.clientX, y: e.clientY },
                  items: [
                    { id: "dir:new-terminal", label: "在此目录新建终端", icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(dir) },
                    { id: "dir:open-editor", label: "在编辑器中打开", icon: "editor", action: () => { openInEditor(externalEditor, dir).catch(() => {}); } },
                    { id: "dir:copy-path", label: "复制路径", icon: "copy", action: () => { navigator.clipboard.writeText(dir).catch(() => {}); } },
                    null,
                    { id: "dir:close-all", label: "关闭全部会话", icon: "close", danger: true, action: () => useSessionsStore.getState().closeSessionsInDir(dir) },
                  ],
                });
              }}
            />
            {!collapsed && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {groupSessions.map((s, idx) => {
                const isDragging = drag?.draggingId === s.id;
                const showIndicator = drag?.sourceDir === dir && drag.overIndex === idx && drag.draggingId !== s.id;
                return (
                  <div key={s.id} data-session-id={s.id} role="listitem">
                    {showIndicator && (
                      <div style={{ height: 2, background: "var(--c-accent)", borderRadius: 1, margin: "0 10px 2px" }} />
                    )}
                    <div
                      onPointerDown={(e) => {
                        if (!canReorder) return;
                        if ((e.target as HTMLElement).closest(".session-card-close") || (e.target as HTMLElement).closest(".hover-close")) return;
                        handleDragStart(e, s.id, dir, idx);
                      }}
                      style={{
                        opacity: isDragging ? 0.3 : 1,
                        transition: "opacity 120ms ease",
                        touchAction: canReorder ? "none" : "auto",
                      }}
                    >
                      <SessionCard
                        session={s}
                        active={s.id === activeSessionId}
                        confirmClose={!!closeConfirmations[s.id]}
                        tabIndex={s.id === tabbableSessionId ? 0 : -1}
                        onClick={() => { if (!dragStarted.current) onSelectSession(s.id); }}
                        onKeyDown={(e) => handleSessionKeyDown(e, s.id)}
                        onClose={onCloseSession ? () => onCloseSession(s.id) : undefined}
                        onRename={(name) => useSessionsStore.getState().renameSession(s.id, name)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({
                            position: { x: e.clientX, y: e.clientY },
                            items: [
                              { id: "session:rename", label: "重命名", icon: "rename", action: () => { useSessionsStore.getState().startRenaming(s.id); } },
                              { id: "session:open-editor", label: "在编辑器中打开", icon: "editor", action: () => { openInEditor(externalEditor, s.dir).catch(() => {}); } },
                              { id: "session:copy-dir", label: "复制目录路径", icon: "copy", action: () => { navigator.clipboard.writeText(s.dir).catch(() => {}); } },
                              null,
                              { id: "session:close", label: "关闭会话", icon: "close", danger: true, action: () => { onCloseSession?.(s.id); } },
                            ],
                          });
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>
          );
        })}
      </div>

      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
