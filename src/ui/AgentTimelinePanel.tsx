import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getResolvedLanguage, useT } from "@/modules/i18n";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import {
  getAgentEventStoreStatus,
  agentEventWorkspaceId,
  isAgentTimelineFeatureEnabled,
  listAgentEvents,
  listenForAgentEventHeaders,
  type AgentEventHeaderV1,
  type AgentEventKind,
  type AgentEventQueryScope,
  type AgentEventStoreStatus,
} from "@/modules/agent-events/agent-event-bridge";
import {
  TIMELINE_PAGE_SIZE,
  captureTimelineAnchor,
  computeTimelineVirtualWindow,
  isCompatibleTimelineHeader,
  isTimelineAtBottom,
  mergeLiveTimelineHeaders,
  mergeOlderTimelinePage,
  restoreTimelineAnchor,
  safeTimelineSummary,
  timelineConfidence,
  type TimelineAnchor,
} from "@/modules/agent-events/timeline-model";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "./types";

interface TaskViewState { scrollTop: number; atBottom: boolean; unread: number; selectedId?: string }
const taskViewStates = new Map<string, TaskViewState>();

export function timelineWorkspaceIdentity(session: Session): string {
  return session.workspace?.repository.id ?? (session.remote
    ? `ssh:${session.remote.user}@${session.remote.host}:${session.remote.port}:${session.dir}`
    : `local:${session.dir}`);
}

function scopeKey(workspaceId: string, taskId: string): string { return `${workspaceId}\u0000${taskId}`; }

function eventKindLabel(kind: AgentEventKind, t: ReturnType<typeof useT>): string { return t(`timeline.kind.${kind}`); }

function formatEventTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "unknown";
  return new Intl.DateTimeFormat(getResolvedLanguage(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(timestamp));
}

function focusSourceTerminal(sessionId: string): void {
  useSessionsStore.getState().setActive(sessionId);
  useUIStore.getState().setPanelVisible(false);
  requestAnimationFrame(() => {
    const pane = [...document.querySelectorAll<HTMLElement>("[data-terminal-session-id]")]
      .find((candidate) => candidate.dataset.terminalSessionId === sessionId);
    pane?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
  });
}

function provenSourceSession(header: AgentEventHeaderV1, sessions: readonly Session[], scopedSession: Session): Session | undefined {
  if (!header.sessionId) return undefined;
  const scopedIdentity = timelineWorkspaceIdentity(scopedSession);
  return sessions.find((candidate) => candidate.id === header.sessionId && timelineWorkspaceIdentity(candidate) === scopedIdentity);
}

function captureRenderedTimelineAnchor(node: HTMLElement): TimelineAnchor | null {
  const viewportTop = node.getBoundingClientRect().top;
  const row = [...node.querySelectorAll<HTMLElement>(".agent-timeline-row")]
    .find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop + 1);
  const eventId = row?.dataset.eventId;
  return row && eventId ? { eventId, viewportOffset: row.getBoundingClientRect().top - viewportTop } : null;
}

interface TimelineRowProps {
  header: AgentEventHeaderV1;
  selected: boolean;
  streaming: boolean;
  sourceSession?: Session;
  onSelect: (eventId: string) => void;
  onMeasure: (eventId: string, height: number) => void;
}

const TimelineRow = memo(function TimelineRow({ header, selected, streaming, sourceSession, onSelect, onMeasure }: TimelineRowProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const confidence = timelineConfidence(header.source);
  const summary = safeTimelineSummary(header.summary) || t("timeline.summary_missing");

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const report = () => onMeasure(header.eventId, Math.ceil(node.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [header.eventId, onMeasure]);

  return (
    <div ref={ref} className="agent-timeline-row" data-selected={selected} data-streaming={streaming} data-event-id={header.eventId} role="option" aria-selected={selected} onClick={() => onSelect(header.eventId)}>
      <div className="agent-timeline-row-topline">
        <span className="agent-timeline-status-dot" data-kind={header.kind} aria-hidden="true" />
        <span className="agent-timeline-kind">{eventKindLabel(header.kind, t)}</span>
        <time className="agent-timeline-time" dateTime={new Date(header.occurredAtMs).toISOString()}>{formatEventTime(header.occurredAtMs)}</time>
      </div>
      <div className="agent-timeline-summary" title={summary}>{summary}</div>
      <div className="agent-timeline-meta">
        <span className="agent-timeline-source" title={header.source}>{header.source}</span>
        <span>{t(`timeline.confidence.${confidence}`)}</span>
        <span title={header.taskId}>{t("timeline.task_short")} {header.taskId}</span>
        <span title={header.sessionId ?? "unknown"}>{sourceSession?.title ?? t("timeline.source_unknown")}</span>
      </div>
      {selected && (
        <div className="agent-timeline-row-actions">
          <span>{t("timeline.selected_hint")}</span>
          <button type="button" disabled={!sourceSession} title={sourceSession?.dir ?? t("timeline.return_disabled")} onClick={(event) => { event.stopPropagation(); if (sourceSession) focusSourceTerminal(sourceSession.id); }}>
            {t("timeline.return_terminal")}
          </button>
        </div>
      )}
    </div>
  );
}, (previous, next) => previous.header === next.header && previous.selected === next.selected && previous.streaming === next.streaming && previous.sourceSession === next.sourceSession);

export function AgentTimelinePanel({ session }: { session: Session }) {
  const t = useT();
  const identity = timelineWorkspaceIdentity(session);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceId(null);
    setIdentityError(false);
    void agentEventWorkspaceId(identity)
      .then((value) => { if (!cancelled) setWorkspaceId(value); })
      .catch(() => { if (!cancelled) setIdentityError(true); });
    return () => { cancelled = true; };
  }, [identity]);

  if (identityError) return <section className="agent-timeline"><div className="agent-timeline-state" role="alert"><strong>{t("timeline.error")}</strong><span>{t("timeline.identity_error")}</span></div></section>;
  if (!workspaceId) return <section className="agent-timeline"><div className="agent-timeline-state">{t("timeline.loading")}</div></section>;
  return <AgentTimelineReady session={session} workspaceId={workspaceId} />;
}

function AgentTimelineReady({ session, workspaceId }: { session: Session; workspaceId: string }) {
  const t = useT();
  const sessions = useSessionsStore((state) => state.sessions);
  const taskId = session.id.slice(0, 256);
  const key = scopeKey(workspaceId, taskId);
  const queryScope = useMemo<AgentEventQueryScope>(() => ({ type: "task", workspaceId, taskId }), [workspaceId, taskId]);
  const [status, setStatus] = useState<AgentEventStoreStatus | null>(null);
  const [items, setItems] = useState<AgentEventHeaderV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [droppedNewer, setDroppedNewer] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [heights, setHeights] = useState(new Map<string, number>());
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  const heightsRef = useRef(new Map<string, number>());
  const virtualRef = useRef(computeTimelineVirtualWindow([], heightsRef.current, 0, 0));
  const keyRef = useRef(key);
  const selectedRef = useRef(selectedId);
  const unreadRef = useRef(unread);
  const droppedNewerRef = useRef(droppedNewer);
  const scrollFrameRef = useRef<number | null>(null);
  const liveFrameRef = useRef<number | null>(null);
  const solidifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paginationAnchorRef = useRef<TimelineAnchor | null>(null);
  const paginationAnchorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const virtualWindow = useMemo(() => computeTimelineVirtualWindow(items.map((item) => item.eventId), heights, scrollTop, viewportHeight), [heights, items, scrollTop, viewportHeight]);
  const hasItems = items.length > 0;
  itemsRef.current = items;
  virtualRef.current = virtualWindow;
  selectedRef.current = selectedId;
  unreadRef.current = unread;
  droppedNewerRef.current = droppedNewer;

  const persistViewState = useCallback((forKey: string) => {
    const node = scrollRef.current;
    const previous = taskViewStates.get(forKey);
    taskViewStates.set(forKey, {
      scrollTop: node?.scrollTop ?? previous?.scrollTop ?? 0,
      atBottom: node ? isTimelineAtBottom(node.scrollTop, node.clientHeight, virtualRef.current.totalSize) : previous?.atBottom ?? true,
      unread: unreadRef.current,
      selectedId: selectedRef.current ?? undefined,
    });
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: Math.max(0, virtualRef.current.totalSize - node.clientHeight), behavior });
    setUnread(0);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = () => setViewportHeight(node.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasItems, loading, status?.capability]);

  useEffect(() => {
    persistViewState(keyRef.current);
    keyRef.current = key;
    const saved = taskViewStates.get(key) ?? { scrollTop: 0, atBottom: true, unread: 0 };
    setStatus(null); setItems([]); setNextCursor(null); setLoading(true); setLoadingOlder(false); setError(null);
    setSelectedId(saved.selectedId ?? null); setUnread(saved.unread); setDroppedNewer(false); setScrollTop(saved.scrollTop);
    paginationAnchorRef.current = null;
    if (paginationAnchorTimerRef.current) { clearTimeout(paginationAnchorTimerRef.current); paginationAnchorTimerRef.current = null; }
    heightsRef.current = new Map(); setHeights(heightsRef.current);
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const liveQueue = new Map<string, AgentEventHeaderV1>();

    if (!isAgentTimelineFeatureEnabled()) { setLoading(false); return () => persistViewState(key); }

    const enqueueLive = (header: AgentEventHeaderV1) => {
      if (cancelled || keyRef.current !== key || !isCompatibleTimelineHeader(header) || header.workspaceId !== workspaceId || header.taskId !== taskId) return;
      liveQueue.set(header.eventId, header);
      if (liveFrameRef.current !== null) return;
      liveFrameRef.current = requestAnimationFrame(() => {
        liveFrameRef.current = null;
        const incoming = [...liveQueue.values()]; liveQueue.clear();
        if (incoming.length === 0 || cancelled || keyRef.current !== key) return;
        if (droppedNewerRef.current) { setUnread((value) => value + incoming.length); return; }
        const node = scrollRef.current;
        const atBottom = node ? isTimelineAtBottom(node.scrollTop, node.clientHeight, virtualRef.current.totalSize) : true;
        setItems((current) => mergeLiveTimelineHeaders(current, incoming));
        const newest = incoming.reduce((left, right) => left.sequence > right.sequence ? left : right);
        setStreamingId(newest.eventId);
        if (solidifyTimerRef.current) clearTimeout(solidifyTimerRef.current);
        solidifyTimerRef.current = setTimeout(() => setStreamingId((current) => current === newest.eventId ? null : current), 420);
        if (atBottom) requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()));
        else setUnread((value) => value + incoming.length);
      });
    };

    void (async () => {
      const nextStatus = await getAgentEventStoreStatus();
      if (cancelled) return;
      setStatus(nextStatus);
      if (nextStatus.capability !== "enabled") { setLoading(false); return; }
      unlisten = await listenForAgentEventHeaders(enqueueLive);
      const page = await listAgentEvents({ scope: queryScope, limit: TIMELINE_PAGE_SIZE });
      if (cancelled) return;
      setItems((current) => mergeLiveTimelineHeaders(page.items.filter(isCompatibleTimelineHeader).reverse(), current));
      setNextCursor(page.nextCursor ?? null); setLoading(false);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const node = scrollRef.current;
        if (!node || keyRef.current !== key) return;
        if (saved.atBottom) scrollToBottom(); else node.scrollTop = saved.scrollTop;
      }));
    })().catch((reason) => { if (!cancelled) { setError(String(reason)); setLoading(false); } });

    return () => {
      persistViewState(key); cancelled = true; unlisten?.();
      if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
      liveFrameRef.current = null; liveQueue.clear();
    };
  }, [key, persistViewState, queryScope, scrollToBottom, taskId, workspaceId]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    if (solidifyTimerRef.current) clearTimeout(solidifyTimerRef.current);
    if (paginationAnchorTimerRef.current) clearTimeout(paginationAnchorTimerRef.current);
  }, []);

  const onMeasure = useCallback((eventId: string, height: number) => {
    if (heightsRef.current.get(eventId) === height) return;
    const node = scrollRef.current;
    const atBottom = node ? isTimelineAtBottom(node.scrollTop, node.clientHeight, virtualRef.current.totalSize) : false;
    const anchor: TimelineAnchor | null = paginationAnchorRef.current
      ?? (node ? captureTimelineAnchor(virtualRef.current, node.scrollTop) : null);
    heightsRef.current.set(eventId, height); setHeights(new Map(heightsRef.current));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!node) return;
      if (atBottom) { scrollToBottom(); return; }
      if (!anchor) return;
      const restored = restoreTimelineAnchor(itemsRef.current.map((item) => item.eventId), heightsRef.current, anchor);
      if (restored !== null) node.scrollTop = restored;
    }));
  }, [scrollToBottom]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) return;
    const node = scrollRef.current;
    const anchor = node ? captureRenderedTimelineAnchor(node) ?? captureTimelineAnchor(virtualRef.current, node.scrollTop) : null;
    paginationAnchorRef.current = anchor;
    if (paginationAnchorTimerRef.current) clearTimeout(paginationAnchorTimerRef.current);
    setLoadingOlder(true);
    try {
      const page = await listAgentEvents({ scope: queryScope, cursor: nextCursor, limit: TIMELINE_PAGE_SIZE });
      const merged = mergeOlderTimelinePage(itemsRef.current, page.items.filter(isCompatibleTimelineHeader));
      flushSync(() => {
        setItems(merged.items);
        if (merged.droppedNewer > 0) setDroppedNewer(true);
        setNextCursor(page.nextCursor ?? null);
      });
      if (anchor && node) {
        const restore = () => {
          const restored = restoreTimelineAnchor(itemsRef.current.map((item) => item.eventId), heightsRef.current, anchor);
          if (restored !== null) { node.scrollTop = restored; setScrollTop(restored); }
        };
        restore();
        requestAnimationFrame(() => requestAnimationFrame(restore));
        paginationAnchorTimerRef.current = setTimeout(() => {
          restore();
          paginationAnchorRef.current = null;
          paginationAnchorTimerRef.current = null;
        }, 80);
      } else {
        paginationAnchorRef.current = null;
      }
    } catch (reason) { setError(String(reason)); } finally { setLoadingOlder(false); }
  }, [loadingOlder, nextCursor, queryScope]);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listAgentEvents({ scope: queryScope, limit: TIMELINE_PAGE_SIZE });
      setItems(page.items.filter(isCompatibleTimelineHeader).reverse()); setNextCursor(page.nextCursor ?? null); setDroppedNewer(false); setUnread(0);
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()));
    } catch (reason) { setError(String(reason)); } finally { setLoading(false); }
  }, [queryScope, scrollToBottom]);

  const selectByOffset = useCallback((offset: number) => {
    if (items.length === 0) return;
    const found = items.findIndex((item) => item.eventId === selectedId);
    const index = Math.max(0, Math.min(items.length - 1, (found < 0 ? 0 : found) + offset));
    const next = items[index]; setSelectedId(next.eventId);
    const node = scrollRef.current;
    const top = node ? restoreTimelineAnchor(items.map((item) => item.eventId), heightsRef.current, { eventId: next.eventId, viewportOffset: 12 }) : null;
    if (node && top !== null && (top < node.scrollTop || top + (heightsRef.current.get(next.eventId) ?? 62) > node.scrollTop + node.clientHeight)) node.scrollTop = top;
  }, [items, selectedId]);

  const returnToSelected = useCallback(() => {
    const header = items.find((item) => item.eventId === selectedId);
    const target = header ? provenSourceSession(header, sessions, session) : undefined;
    if (target) focusSourceTerminal(target.id);
  }, [items, selectedId, session, sessions]);

  const worktree = currentWorkspaceWorktree(session.workspace);
  const sourceTitle = session.workspace && worktree ? `${session.workspace.repository.name}/${worktree.name}` : session.dir;
  const capability = isAgentTimelineFeatureEnabled() ? status?.capability : "featureDisabled";

  return (
    <section className="agent-timeline" aria-label={t("timeline.title")}>
      <header className="agent-timeline-header">
        <div className="agent-timeline-orientation"><span className="agent-timeline-kicker">{t("timeline.title")}</span><strong title={sourceTitle}>{sourceTitle}</strong><span title={taskId}>{session.title}</span></div>
        <div className="agent-timeline-header-actions">{nextCursor && <button type="button" data-timeline-action="older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? t("timeline.loading_older") : t("timeline.load_older")}</button>}{unread > 0 && <button type="button" data-timeline-action="unread" onClick={() => scrollToBottom()}>{t("timeline.unread", { count: unread })}</button>}{droppedNewer && <button type="button" data-timeline-action="latest" onClick={() => void loadLatest()}>{t("timeline.latest")}</button>}</div>
      </header>
      {loading && <div className="agent-timeline-state">{t("timeline.loading")}</div>}
      {!loading && capability !== "enabled" && <div className="agent-timeline-state" role="status"><strong>{t(`timeline.capability.${capability ?? "unavailable"}`)}</strong><span>{t("timeline.capability_hint")}</span></div>}
      {!loading && error && <div className="agent-timeline-state" role="alert"><strong>{t("timeline.error")}</strong><span>{error}</span></div>}
      {!loading && !error && capability === "enabled" && items.length === 0 && <div className="agent-timeline-state"><strong>{t("timeline.empty")}</strong><span>{t("timeline.empty_hint")}</span></div>}
      {!loading && !error && capability === "enabled" && items.length > 0 && (
        <div ref={scrollRef} className="agent-timeline-scroll" role="listbox" aria-label={t("timeline.events")} tabIndex={0} data-retained-count={items.length} data-total-size={Math.round(virtualWindow.totalSize)} data-unread={unread}
          onScroll={(event) => { const node = event.currentTarget; if (scrollFrameRef.current !== null) return; scrollFrameRef.current = requestAnimationFrame(() => { scrollFrameRef.current = null; setScrollTop(node.scrollTop); const atBottom = isTimelineAtBottom(node.scrollTop, node.clientHeight, virtualRef.current.totalSize); taskViewStates.set(key, { scrollTop: node.scrollTop, atBottom, unread: atBottom ? 0 : unreadRef.current, selectedId: selectedRef.current ?? undefined }); if (atBottom && unreadRef.current > 0) setUnread(0); }); }}
          onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); selectByOffset(event.key === "ArrowDown" ? 1 : -1); } else if (event.key === "PageUp") { event.preventDefault(); if (scrollRef.current) scrollRef.current.scrollTop -= Math.max(120, scrollRef.current.clientHeight - 60); if (nextCursor) void loadOlder(); } else if (event.key === "PageDown") { event.preventDefault(); if (scrollRef.current) scrollRef.current.scrollTop += Math.max(120, scrollRef.current.clientHeight - 60); } else if (event.key === "End") { event.preventDefault(); if (droppedNewer) void loadLatest(); else scrollToBottom(); } else if (event.key === "Enter") { event.preventDefault(); returnToSelected(); } else if (event.key === "Escape") { event.preventDefault(); focusSourceTerminal(session.id); } }}>
          <div className="agent-timeline-virtual-space" style={{ height: virtualWindow.totalSize }}>
            {virtualWindow.rows.map((layout) => { const header = items[layout.index]; if (!header) return null; const sourceSession = provenSourceSession(header, sessions, session); return <div key={header.eventId} className="agent-timeline-virtual-row" style={{ transform: `translateY(${layout.start}px)` }}><TimelineRow header={header} selected={selectedId === header.eventId} streaming={streamingId === header.eventId} sourceSession={sourceSession} onSelect={setSelectedId} onMeasure={onMeasure} /></div>; })}
          </div>
        </div>
      )}
    </section>
  );
}
