import { GlobalAgentBar } from "./GlobalAgentBar";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { deriveTitle, type Session } from "./types";
import { SidebarSearchIcon } from "./SidebarDirGroupHeader";
import { SidebarSessionGroup } from "./SidebarSessionGroup";
import { CloseIcon } from "./shared";
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { getNumberRecordValue, hasTrueRecordKey } from "@/state/record-keys";
import { buildSessionMenuItems } from "./sidebar-session-menu";
import { useT } from "@/modules/i18n";
import { SidebarNewTerminalControl } from "./SidebarNewTerminalControl"; import { SidebarHosts } from "./SidebarHosts";
import {
  groupSessionsForSidebar,
  sessionMatchesSidebarSearch,
  sidebarGroupKey,
} from "@/modules/session/sidebar-groups";

// Session menu source anchors: label: t("sidebar.session.rename"), icon: "rename"; label: t("sidebar.session.close"), icon: "close"
interface DragState {
  draggingId: string;
  sourceGroupKey: string;
  overIndex: number;
}

interface SidebarProps {
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewTerminal?: () => void;
  onNewTerminalInDirectory?: () => void;
  onCloseSession?: (id: string) => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewTerminal,
  onNewTerminalInDirectory,
  onCloseSession,
}: SidebarProps) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const dragRef = useRef<DragState | null>(null);
  const dragStartY = useRef(0);
  const dragStarted = useRef(false);
  // 拖拽中途组件被卸载时兜底摘掉 document 监听
  const dragTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragTeardownRef.current?.(), []);
  const closeConfirmations = useSessionsStore((s) => s.closeConfirmations);
  const dirCloseConfirmations = useSessionsStore((s) => s.dirCloseConfirmations);
  const collapsedDirs = useUIStore((s) => s.collapsedDirs);
  const toggleDirCollapsed = useUIStore((s) => s.toggleDirCollapsed);
  const hasSessions = sessions.length > 0;
  const q = search.trim().toLowerCase();
  // Derived view of the session list. Memoized so an unrelated sessions-store
  // update (e.g. an agent heartbeat that rebuilds the sessions array) doesn't
  // re-run filter/group/flatten on every render.
  const filtered = useMemo(
    () => (q ? sessions.filter((s) => sessionMatchesSidebarSearch(s, q)) : sessions),
    [sessions, q],
  );
  const canReorder = q.length === 0;
  const groupEntries = useMemo(() => groupSessionsForSidebar(filtered), [filtered]);
  // Kept as a plain derivation (cheap flatMap) — a structure-regression test
  // locks this exact line shape; the heavy work (filter/group) is already
  // memoized above.
  const visibleSessionIds = groupEntries.flatMap((group) =>
    hasTrueRecordKey(collapsedDirs, group.key) && !q ? [] : group.sessions.map((s) => s.id)
  );
  const tabbableSessionId = visibleSessionIds.includes(activeSessionId) ? activeSessionId : visibleSessionIds[0] ?? null;
  const visibleSessionIdsRef = useRef(visibleSessionIds); // read by handleSessionKeyDown (keeps its deps stable for memo)
  visibleSessionIdsRef.current = visibleSessionIds;

  const focusSessionCard = useCallback((sessionId: string) => {
    requestAnimationFrame(() => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-session-card-id]")).find(
        (el) => el.dataset.sessionCardId === sessionId,
      );
      // The outer card div has no tabIndex — focus() on it is a no-op. The
      // keyboard-focusable element is the overlay select button inside it.
      const target = card?.querySelector<HTMLElement>(".session-card-select") ?? card;
      target?.focus();
      card?.scrollIntoView({ block: "nearest" });
    });
  }, []);

  const handleSessionKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>, sessionId: string) => {
    const ids = visibleSessionIdsRef.current;
    const currentIndex = ids.indexOf(sessionId);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (e.key === "ArrowDown") nextIndex = Math.min(currentIndex + 1, ids.length - 1);
    else if (e.key === "ArrowUp") nextIndex = Math.max(currentIndex - 1, 0);
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = ids.length - 1;
    else return;

    const nextId = ids[nextIndex];
    if (!nextId) return;
    e.preventDefault();
    onSelectSession(nextId);
    focusSessionCard(nextId);
  }, [focusSessionCard, onSelectSession]);

  const handleSelect = useCallback((id: string) => {
    if (!dragStarted.current) onSelectSession(id);
  }, [onSelectSession]);

  const handleClose = useCallback((id: string) => { onCloseSession?.(id); }, [onCloseSession]);
  const handleRename = useCallback((id: string, name: string) => { useSessionsStore.getState().renameSession(id, name); }, []);
  const handleContextMenu = useCallback((e: React.MouseEvent, session: Session) => {
    e.preventDefault();
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      items: buildSessionMenuItems({
        session, t, externalEditor, onSelectSession, onCloseSession, canReorder,
        groupSessions: sessions.filter((candidate) => sidebarGroupKey(candidate) === sidebarGroupKey(session)),
        onReordered: (position) => setReorderAnnouncement(t("sidebar.session.moved", { session: deriveTitle(session).primary, position })),
      }),
    });
  }, [t, externalEditor, onCloseSession, onSelectSession, canReorder, sessions]);

  const handleDragStart = useCallback((e: React.PointerEvent, sessionId: string, groupKey: string, index: number) => {
    dragStartY.current = e.clientY;
    dragStarted.current = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!dragStarted.current && Math.abs(ev.clientY - dragStartY.current) > 4) {
        dragStarted.current = true;
        const initial: DragState = { draggingId: sessionId, sourceGroupKey: groupKey, overIndex: index };
        dragRef.current = initial;
        setDrag(initial);
      }
      if (!dragStarted.current) return;

      const container = el.closest("[data-sidebar-group]");
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
      dragTeardownRef.current = null;
      const finalDrag = dragRef.current;
      if (dragStarted.current && finalDrag) {
        const current = useSessionsStore.getState().sessions;
        const fromIdx = current.filter((s) => sidebarGroupKey(s) === finalDrag.sourceGroupKey).findIndex((s) => s.id === finalDrag.draggingId);
        if (fromIdx !== -1) {
          useSessionsStore.getState().reorderInGroup(finalDrag.sourceGroupKey, fromIdx, finalDrag.overIndex);
        }
      }
      dragRef.current = null;
      setDrag(null);
      dragStarted.current = false;
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
    dragTeardownRef.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
      dragRef.current = null;
      dragStarted.current = false;
    };
  }, []);

  return (
    <div
      style={{
        width: "100%",
        background: "var(--c-bg-2)",
        borderRight: "1px solid var(--c-border-1)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
      aria-label={t("sidebar.aria_label")}
      role="navigation"
    >
      {hasSessions && onNewTerminal && (
        <SidebarNewTerminalControl
          onNewTerminal={onNewTerminal}
          onNewTerminalInDirectory={onNewTerminalInDirectory}
        />
      )}
      {hasSessions && <SidebarHosts sessions={sessions} activeSessionId={activeSessionId} onSelectSession={onSelectSession} />}
      {hasSessions && <div style={{ padding: "6px 12px" }}>
        <div
          className="sidebar-search"
          style={{
            background: "transparent",
            borderRadius: "var(--r-input)",
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "6px 10px",
            border: "1px solid var(--c-control-border)",
            transition: "background var(--duration-fast) ease, border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease",
          }}
        >
          <SidebarSearchIcon />
          <input className="ui-native-control"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("sidebar.search.placeholder")}
            aria-label={t("sidebar.search.aria_label")}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: "var(--fs-body)",
              color: "var(--c-text-primary)",
              fontFamily: "var(--font-ui)",
              minWidth: 0,
            }}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="hover-bg"
              title={t("common.clear_search")}
              aria-label={t("common.clear_search")}
              style={{
                width: 18,
                height: 18,
                borderRadius: "var(--r-btn)",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--c-text-5)",
                flexShrink: 0,
              }}
            >
              <CloseIcon size={11} strokeWidth={2.4} />
            </button>
          )}
        </div>
        {q && <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", padding: "2px 12px 0", lineHeight: 1.4 }}>{t("sidebar.search.no_drag")}</div>}
      </div>}

      <GlobalAgentBar sessions={sessions} onSelectSession={onSelectSession} />

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 8px",
        }}
        className="no-scrollbar scroll-fade-y scroll-fade-sidebar"
        role="list"
        aria-label={t("sidebar.list.aria_label")}
      >
        {hasSessions && filtered.length === 0 && (
          <div style={{ padding: "24px 12px", textAlign: "center", fontSize: "var(--fs-meta)", color: "var(--c-text-5)", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <span>{q ? t("sidebar.empty.no_match") : t("sidebar.empty.none")}</span>
            {q ? (
              <button type="button" className="ui-button" onClick={() => setSearch("")}>
                {t("common.clear_search")}
              </button>
            ) : onNewTerminal ? (
              <button type="button" className="ui-button ui-button--primary" onClick={onNewTerminal}>
                {t("sidebar.new_terminal")}
              </button>
            ) : null}
          </div>
        )}

        {groupEntries.map((group) => (
          <SidebarSessionGroup
            key={group.key}
            group={group}
            collapsed={hasTrueRecordKey(collapsedDirs, group.key) && !q}
            activeSessionId={activeSessionId}
            tabbableSessionId={tabbableSessionId}
            canReorder={canReorder}
            drag={drag}
            confirmClose={getNumberRecordValue(dirCloseConfirmations, group.key) > 0}
            closeConfirmations={closeConfirmations}
            externalEditor={externalEditor}
            t={t}
            onToggleCollapse={() => toggleDirCollapsed(group.key)}
            onOpenMenu={(items, position) => setContextMenu({ items, position })}
            onDragStart={handleDragStart}
            onSelect={handleSelect}
            onKeyDown={handleSessionKeyDown}
            onClose={handleClose}
            onRename={handleRename}
            onContextMenu={handleContextMenu}
          />
        ))}
      </div>

      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only">{reorderAnnouncement}</div>
    </div>
  );
}
