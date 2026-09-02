import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deriveTitle, type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { formatShortcut } from "./formatShortcut";
import { platform } from "@tauri-apps/plugin-os";
import { useT } from "@/modules/i18n";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import {
  groupSessionsForSidebar,
  representativeSession,
  sidebarGroupKey,
  titlebarDeviceCaption,
} from "@/modules/session/sidebar-groups";
import { splitToolbarOverflow } from "./lib/toolbar-overflow";
import { copyActiveTerminal, safePasteActiveTerminal, searchActiveTerminal } from "@/modules/terminal/lib/terminal-action-registry";
import { TERMINAL_CONTEXT_ANNOUNCEMENT_EVENT, type TerminalContextAnnouncement } from "@/modules/terminal/lib/terminal-context-announcement";
import type { ConnectionPhase } from "@/modules/terminal/lib/connection-state";

let _isMac = true;
try { _isMac = platform() === "macos"; } catch { _isMac = navigator.platform.toLowerCase().includes("mac"); }

// WebKit's `-webkit-app-region` CSS property is not in the standard
// React.CSSProperties type. Model just the one vendor extension we use.
type DragStyle = React.CSSProperties & { WebkitAppRegion?: string };

const TITLEBAR_ICON_STYLE: React.CSSProperties = { width: 16, height: 16, flexShrink: 0 };
const MAC_TITLEBAR_CONTROL_Y_OFFSET = -1;
const FULLSCREEN_EXIT_HINT_DURATION_MS = 1200;

interface TitlebarProps {
  sessions: Session[];
  activeSessionId: string;
  panelVisible: boolean;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewTerminal: () => void;
  onNewTerminalInDirectory: () => void;
  onOpenSettings: () => void;
}

function PanelLeftIcon({ active }: { active: boolean }) {
  return (
    <svg style={TITLEBAR_ICON_STYLE} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill={active ? "var(--c-accent)" : "currentColor"} fillOpacity={active ? 0.3 : 0.1} />
    </svg>
  );
}

function PresentationModeIcon() {
  return (
    <svg style={TITLEBAR_ICON_STYLE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 2.5h-3v3" />
      <path d="M10.5 2.5h3v3" />
      <path d="M13.5 10.5v3h-3" />
      <path d="M5.5 13.5h-3v-3" />
    </svg>
  );
}

interface PresentationModeButtonProps {
  label: string;
  shortcut: string;
  onClick: () => void;
  showShortcut?: boolean;
  surface?: boolean;
  floating?: boolean;
  draggable?: boolean;
  visible?: boolean;
  onKeepVisible?: () => void;
  onReleaseVisible?: () => void;
}

function PresentationModeButton({
  label,
  shortcut,
  onClick,
  showShortcut = false,
  surface = false,
  floating = false,
  draggable = false,
  visible = true,
  onKeepVisible,
  onReleaseVisible,
}: PresentationModeButtonProps) {
  const accessibleLabel = `${label} ${shortcut}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; offset: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const clampDragOffset = useCallback((offset: number) => {
    const button = buttonRef.current;
    if (!button) return offset;
    const rect = button.getBoundingClientRect();
    const baseLeft = rect.left - dragOffset;
    const edge = 8;
    return Math.min(
      window.innerWidth - edge - rect.width - baseLeft,
      Math.max(edge - baseLeft, offset),
    );
  }, [dragOffset]);

  useEffect(() => {
    const keepInViewport = () => setDragOffset((offset) => clampDragOffset(offset));
    window.addEventListener("resize", keepInViewport);
    return () => window.removeEventListener("resize", keepInViewport);
  }, [clampDragOffset]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!draggable || event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offset: dragOffset, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    onKeepVisible?.();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    const verticalDelta = event.clientY - drag.startY;
    if (!drag.moved && Math.max(Math.abs(delta), Math.abs(verticalDelta)) < 4) return;
    drag.moved = true;
    setDragOffset(clampDragOffset(drag.offset + delta));
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onReleaseVisible?.();
  };

  const cancelDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    suppressClickRef.current = false;
    setDragOffset(clampDragOffset(drag.offset));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onReleaseVisible?.();
  };

  return (
    <button
      ref={buttonRef}
      type="button"
      data-presentation-action={floating ? "exit-fullscreen-pure" : undefined}
      data-visible={floating ? String(visible) : undefined}
      onClick={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          event.preventDefault();
          return;
        }
        onClick();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      onPointerEnter={onKeepVisible}
      onPointerLeave={onReleaseVisible}
      onFocus={onKeepVisible}
      onBlur={onReleaseVisible}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      className={floating || surface ? "presentation-mode-exit-hint" : "hover-bg"}
      style={{
        height: floating ? 30 : "var(--h-titlebar-control)",
        padding: floating ? "0 10px" : "0 8px",
        borderRadius: "var(--r-btn)",
        border: floating || surface ? "1px solid var(--c-border-1)" : "none",
        background: floating || surface ? undefined : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        whiteSpace: "nowrap",
        touchAction: draggable ? "none" : undefined,
        userSelect: draggable ? "none" : undefined,
        translate: draggable ? `${dragOffset}px 0` : undefined,
        ...(floating ? {
          position: "fixed",
          top: visible ? 8 : -26,
          left: "50%",
          zIndex: 900,
          opacity: visible ? 1 : 0.01,
          transform: "translateX(-50%)",
          pointerEvents: "auto",
          transition: "opacity var(--duration-normal) var(--ease-smooth), transform var(--duration-normal) var(--ease-out-expo)",
          boxShadow: "var(--shadow-menu)",
        } : {}),
      }}
    >
      <PresentationModeIcon />
      <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 500 }}>{label}</span>
      {showShortcut && (
        <kbd style={{
          padding: "1px 4px",
          borderRadius: "var(--r-badge-sm)",
          background: "var(--c-bg-2)",
          color: "var(--c-text-4)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-meta-sm)",
          lineHeight: 1.4,
        }}>
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

function PureModeActionStrip({ activeSessionId, exitShortcut, fullscreen = false, includeExit = true }: { activeSessionId: string; exitShortcut: string; fullscreen?: boolean; includeExit?: boolean }) {
  const t = useT();
  const activeSession = useSessionsStore((state) => state.sessions.find((session) => session.id === activeSessionId));
  const showFilesButton = useUIStore((state) => state.showPureModeFilesButton);
  const [visible, setVisible] = useState(true);
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const [overflowMenu, setOverflowMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const [contextAnnouncement, setContextAnnouncement] = useState<TerminalContextAnnouncement | null>(null);
  const hideTimer = useRef<number | null>(null);
  const overflowMenuRef = useRef(overflowMenu);
  overflowMenuRef.current = overflowMenu;
  const labelRef = useRef<HTMLSpanElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const itemWidthCache = useRef(new Map<string, number>());

  const keepVisible = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setVisible(true);
  }, []);
  const releaseVisible = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      if (overflowMenuRef.current) return;
      setVisible(false);
    }, 1400);
  }, []);

  useEffect(() => {
    releaseVisible();
    const revealAtEdge = (event: PointerEvent) => {
      if (event.clientY <= 12 || event.pointerType === "touch") keepVisible();
    };
    window.addEventListener("pointermove", revealAtEdge, { passive: true });
    window.addEventListener("pointerdown", revealAtEdge, { passive: true });
    return () => {
      window.removeEventListener("pointermove", revealAtEdge);
      window.removeEventListener("pointerdown", revealAtEdge);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [keepVisible, releaseVisible]);

  useEffect(() => {
    const updateContext = (event: Event) => {
      setContextAnnouncement((event as CustomEvent<TerminalContextAnnouncement>).detail);
    };
    window.addEventListener(TERMINAL_CONTEXT_ANNOUNCEMENT_EVENT, updateContext);
    return () => window.removeEventListener(TERMINAL_CONTEXT_ANNOUNCEMENT_EVENT, updateContext);
  }, []);

  useEffect(() => {
    setContextAnnouncement((current) => current?.logicalSessionId === activeSessionId ? current : null);
  }, [activeSessionId]);

  useEffect(() => {
    if (!contextAnnouncement) return;
    const timeout = window.setTimeout(() => setContextAnnouncement(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [contextAnnouncement]);

  useEffect(() => {
    const mq = window.matchMedia?.("(pointer: coarse)");
    if (!mq) return;
    const update = () => setCoarsePointer(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const actions = useMemo(() => [
    { id: "paste", label: t("pure.action.safe_paste"), run: () => void safePasteActiveTerminal(activeSessionId) },
    { id: "copy", label: t("term.copy"), run: () => void copyActiveTerminal(activeSessionId) },
    { id: "search", label: t("pure.action.search"), run: () => searchActiveTerminal(activeSessionId) },
    { id: "files", label: t("pure.files.button"), run: () => {
      const ui = useUIStore.getState();
      ui.setInspectorTab("files", { sessionId: activeSessionId });
      ui.setPanelVisible(true);
    } },
    { id: "palette", label: t("pure.action.command_palette"), run: () => useUIStore.getState().setOverlay("command-palette") },
    ...(includeExit ? [{ id: "exit", label: t("palette.cmd.exit_pure"), run: () => useUIStore.getState().setPresentationMode("workspace") }] : []),
  ], [activeSessionId, includeExit, t]);
  const inlineCandidates = useMemo(
    () => actions.filter((action) => action.id !== "files" || showFilesButton),
    [actions, showFilesButton],
  );
  const extraOverflow = useMemo(
    () => actions.filter((action) => action.id === "files" && !showFilesButton),
    [actions, showFilesButton],
  );
  const overflowActions = [
    ...inlineCandidates.filter((action) => collapsedIds.includes(action.id)),
    ...extraOverflow,
  ];
  const announcedSession = useSessionsStore((state) => contextAnnouncement
    ? state.sessions.find((session) => session.id === contextAnnouncement.logicalSessionId)
    : undefined);
  const contextSession = contextAnnouncement ? announcedSession : activeSession;
  const cue = contextSession?.agentActivity === "waiting_confirmation"
    ? t("pure.cue.waiting")
    : contextSession?.unread
      ? t("pure.cue.unread")
      : "";
  const sessionLabel = contextSession
    ? deriveTitle(contextSession).primary
    : contextAnnouncement?.title || t("pure.cue.no_session");
  const contextPosition = contextAnnouncement?.index !== undefined && contextAnnouncement.total !== undefined
    ? `${contextAnnouncement.index}/${contextAnnouncement.total}`
    : "";

  useLayoutEffect(() => {
    const measure = () => {
      for (const action of inlineCandidates) {
        const el = labelRef.current?.parentElement?.querySelector<HTMLElement>(`[data-pure-action="${CSS.escape(action.id)}"]`);
        const width = el?.offsetWidth ?? 0;
        if (width > 0) itemWidthCache.current.set(action.id, width);
      }
      const widths = inlineCandidates.map((action) => itemWidthCache.current.get(action.id) ?? 0);
      const overflowWidth = overflowBtnRef.current?.offsetWidth || 36;
      const labelWidth = labelRef.current?.offsetWidth ?? 0;
      const inset = fullscreen ? 20 : 24;
      const available = coarsePointer
        ? 0
        : Math.max(0, window.innerWidth - inset - 8 - labelWidth - 2);
      const split = splitToolbarOverflow(
        inlineCandidates,
        widths,
        available,
        overflowWidth,
        2,
        extraOverflow.length > 0 || coarsePointer,
      );
      const nextIds = split.overflow.map((action) => action.id);
      setCollapsedIds((current) => (
        current.length === nextIds.length && current.every((id, index) => id === nextIds[index])
          ? current
          : nextIds
      ));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [coarsePointer, extraOverflow.length, fullscreen, inlineCandidates, sessionLabel]);

  useEffect(() => {
    setOverflowMenu(null);
  }, [showFilesButton, includeExit]);

  const toggleOverflowMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (overflowMenu) {
      setOverflowMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setOverflowMenu({
      items: overflowActions.map((action) => ({
        id: `pure:${action.id}`,
        label: action.label,
        action: action.run,
      })),
      position: { x: Math.max(8, rect.right - 180), y: rect.bottom + 4 },
    });
    keepVisible();
  };

  const buttonStyle: React.CSSProperties = {
    minHeight: 30,
    padding: "0 9px",
    border: "none",
    borderRadius: "var(--r-btn)",
    background: "transparent",
    color: "var(--c-text-2)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  };

  return (
    <div
      role="toolbar"
      aria-label={t("pure.action_strip")}
      data-pure-action-strip
      data-visible={String(visible)}
      inert={!visible || undefined}
      aria-hidden={!visible}
      onPointerEnter={keepVisible}
      onPointerLeave={releaseVisible}
      onFocusCapture={keepVisible}
      onBlurCapture={releaseVisible}
      style={{
        position: "fixed",
        top: visible ? (fullscreen ? 44 : 7) : -28,
        left: fullscreen ? 10 : "50%",
        zIndex: 890,
        transform: fullscreen ? undefined : "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "2px 4px",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-card)",
        background: "var(--c-bg-white)",
        boxShadow: "var(--shadow-menu)",
        opacity: visible ? 1 : 0.02,
        maxWidth: fullscreen ? "calc(100vw - 20px)" : "calc(100vw - 24px)",
        transition: "top var(--duration-normal) var(--ease-smooth), opacity var(--duration-normal) var(--ease-smooth)",
        WebkitAppRegion: "no-drag",
      } as DragStyle}
    >
      <span ref={labelRef} role="status" aria-live="polite" title={sessionLabel} style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 7px", fontSize: "var(--fs-meta)", color: cue ? "var(--c-accent)" : "var(--c-text-4)" }}>
        {sessionLabel}{contextPosition ? ` · ${contextPosition}` : ""}{cue ? ` · ${cue}` : ""}
      </span>
      {inlineCandidates.map((action) => (
        <button
          key={action.id}
          type="button"
          data-pure-action={action.id}
          aria-label={action.id === "files" ? t("pure.files.open") : action.id === "exit" ? `${action.label} ${exitShortcut}` : action.label}
          style={{
            ...buttonStyle,
            display: collapsedIds.includes(action.id) ? "none" : undefined,
          }}
          className="hover-bg"
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
      <button
        ref={overflowBtnRef}
        type="button"
        data-touch-overflow
        aria-label={t("common.more_actions")}
        title={t("common.more_actions")}
        aria-haspopup="menu"
        aria-expanded={overflowMenu !== null}
        hidden={overflowActions.length === 0}
        style={{ ...buttonStyle, display: overflowActions.length === 0 ? "none" : "flex", alignItems: "center" }}
        className="hover-bg"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={toggleOverflowMenu}
      >
        •••
      </button>
      {overflowMenu && (
        <ContextMenu
          items={overflowMenu.items}
          position={overflowMenu.position}
          onClose={() => {
            setOverflowMenu(null);
            releaseVisible();
          }}
          returnFocusToken={overflowBtnRef}
        />
      )}
    </div>
  );
}

function deviceConnectionColor(phase: ConnectionPhase | null): string {
  if (phase === "ready") return "var(--c-success)";
  if (phase === "failed" || phase === "disconnected" || phase === "exited") return "var(--c-error)";
  if (phase === "needsUserAction" || phase === "verifyingHostKey") return "var(--c-warning)";
  return phase ? "var(--c-accent)" : "var(--c-text-7)";
}

function DeviceIdentityContent({
  label,
  kind,
  connectionPhase,
}: {
  label: string;
  kind: "local" | "ssh" | null;
  connectionPhase: ConnectionPhase | null;
}) {
  return (
    <>
      {kind === "ssh" && (
        <span
          aria-hidden="true"
          data-titlebar-connection-phase={connectionPhase ?? "unknown"}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: deviceConnectionColor(connectionPhase),
            flexShrink: 0,
          }}
        />
      )}
      <span style={{
        fontSize: "var(--fs-secondary)",
        fontWeight: 600,
        color: "var(--c-text-primary)",
        fontFamily: "var(--font-ui)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {label}
      </span>
    </>
  );
}

function WindowControls() {
  const t = useT();
  const win = tryGetCurrentWindow();
  if (!win) return null;
  const btnBase: React.CSSProperties = {
    width: 28,
    height: 28,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--c-text-4)",
    borderRadius: "var(--r-btn)",
    flexShrink: 0,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        onClick={() => win.minimize()}
        title={t("titlebar.window.minimize")}
        className="hover-bg"
        style={btnBase}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
      </button>
      <button
        onClick={() => win.toggleMaximize()}
        title={t("titlebar.window.maximize")}
        className="hover-bg"
        style={btnBase}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1" />
        </svg>
      </button>
      <button
        onClick={() => win.close()}
        title={t("titlebar.window.close")}
        className="hover-close"
        style={btnBase}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="3" y1="3" x2="9" y2="9" />
          <line x1="9" y1="3" x2="3" y2="9" />
        </svg>
      </button>
    </div>
  );
}

function TitlebarImpl({
  sessions,
  activeSessionId,
  panelVisible,
  sidebarVisible,
  onToggleSidebar,
  onTogglePanel,
  onSelectSession: _onSelectSession,
  onCloseSession: _onCloseSession,
  onNewTerminal,
  onNewTerminalInDirectory,
  onOpenSettings,
}: TitlebarProps) {
  const t = useT();
  const presentationMode = useUIStore((s) => s.presentationMode);
  const nativeFullscreen = useUIStore((s) => s.nativeFullscreen);
  const deviceCaption = useMemo(() => {
    const groups = groupSessionsForSidebar(sessions);
    const active = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
    const group = active
      ? groups.find((candidate) => candidate.key === sidebarGroupKey(active)) ?? null
      : null;
    if (!group) return null;
    const { label, detail } = titlebarDeviceCaption(group);
    const currentSession = representativeSession(group.sessions, activeSessionId);
    return {
      key: group.key,
      kind: group.kind,
      label,
      detail,
      connectionPhase: group.kind === "ssh" ? currentSession?.connection?.phase ?? null : null,
    };
  }, [sessions, activeSessionId]);
  const trafficLightWidth = useUIStore((s) => s.trafficLightWidth);
  const newTerminalShortcut = useUIStore((s) => s.keybindings.newTerminal);
  const presentationModeBinding = useUIStore((s) => s.keybindings.togglePresentationMode);
  const presentationModeShortcut = formatShortcut(presentationModeBinding);
  const setPresentationMode = useUIStore((s) => s.setPresentationMode);
  const fullscreenHintTimerRef = useRef<number | null>(null);
  const [fullscreenExitHintVisible, setFullscreenExitHintVisible] = useState(false);
  const [newTerminalMenu, setNewTerminalMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const workspaceMenuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (presentationMode === "pure") {
      setNewTerminalMenu(null);
      setWorkspaceMenu(null);
    }
  }, [presentationMode]);

  const clearFullscreenHintTimer = useCallback(() => {
    if (fullscreenHintTimerRef.current !== null) {
      window.clearTimeout(fullscreenHintTimerRef.current);
      fullscreenHintTimerRef.current = null;
    }
  }, []);

  const keepFullscreenExitHintVisible = useCallback(() => {
    clearFullscreenHintTimer();
    setFullscreenExitHintVisible(true);
  }, [clearFullscreenHintTimer]);

  const revealFullscreenExitHint = useCallback(() => {
    keepFullscreenExitHintVisible();
    fullscreenHintTimerRef.current = window.setTimeout(() => {
      fullscreenHintTimerRef.current = null;
      setFullscreenExitHintVisible(false);
    }, FULLSCREEN_EXIT_HINT_DURATION_MS);
  }, [keepFullscreenExitHintVisible]);

  useEffect(() => {
    if (presentationMode === "pure" && nativeFullscreen) {
      revealFullscreenExitHint();
    } else {
      clearFullscreenHintTimer();
      setFullscreenExitHintVisible(false);
    }
    return clearFullscreenHintTimer;
  }, [clearFullscreenHintTimer, nativeFullscreen, presentationMode, revealFullscreenExitHint]);

  useEffect(() => {
    if (presentationMode !== "pure" || !nativeFullscreen) return;
    const revealAtTopEdge = (event: PointerEvent) => {
      if (event.clientY <= 10) revealFullscreenExitHint();
    };
    window.addEventListener("pointermove", revealAtTopEdge, { passive: true });
    return () => window.removeEventListener("pointermove", revealAtTopEdge);
  }, [nativeFullscreen, presentationMode, revealFullscreenExitHint]);

  const openNewTerminalMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setNewTerminalMenu({
      position: event.type === "contextmenu"
        ? { x: event.clientX, y: event.clientY }
        : { x: rect.left, y: rect.bottom },
      items: [
        { id: "new-terminal", label: t("titlebar.new_terminal"), icon: "terminal", action: onNewTerminal },
        { id: "new-terminal-directory", label: t("titlebar.new_terminal_in_directory"), icon: "folder", action: onNewTerminalInDirectory },
        null,
        { id: "new-ssh-session", label: t("titlebar.new_ssh_session"), icon: "ssh", action: () => useUIStore.getState().openSshConnect() },
      ],
    });
  };

  const openWorkspaceMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setWorkspaceMenu({
      position: { x: rect.right, y: rect.bottom },
      items: [
        { id: "toggle-panel", label: panelVisible ? t("titlebar.panel.hide") : t("titlebar.panel.show"), action: onTogglePanel },
        { id: "pure-mode", label: t("titlebar.pure_mode"), action: () => setPresentationMode("pure") },
        { id: "settings", label: t("titlebar.settings"), action: onOpenSettings },
      ],
    });
  };

  const titlebarControlTransform = _isMac ? `translateY(${MAC_TITLEBAR_CONTROL_Y_OFFSET}px)` : undefined;
  const deviceConnectionLabel = deviceCaption?.connectionPhase
    ? t(`connection.phase.${deviceCaption.connectionPhase}`)
    : "";
  const deviceAccessibleName = deviceCaption
    ? [
        deviceCaption.kind === "ssh"
          ? `${deviceCaption.label}, ${t("workspace.ssh")}`
          : deviceCaption.label,
        deviceConnectionLabel,
      ].filter(Boolean).join(", ")
    : "";
  const deviceTitle = deviceCaption
    ? [deviceCaption.detail || deviceCaption.label, deviceConnectionLabel].filter(Boolean).join(" · ")
    : "";
  const deviceIdentityStyle = {
    height: "var(--h-titlebar-control)",
    maxWidth: "min(280px, 36vw)",
    padding: "0 8px",
    marginLeft: 2,
    borderRadius: "var(--r-btn)",
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
    transform: titlebarControlTransform,
  } satisfies React.CSSProperties;

  if (presentationMode === "pure") {
    if (nativeFullscreen) {
      return (
        <>
          <PureModeActionStrip activeSessionId={activeSessionId} exitShortcut={presentationModeShortcut} fullscreen includeExit={false} />
          <PresentationModeButton
            label={t("palette.cmd.exit_pure")}
            shortcut={presentationModeShortcut}
            onClick={() => setPresentationMode("workspace")}
            showShortcut
            floating
            draggable
            visible={fullscreenExitHintVisible}
            onKeepVisible={keepFullscreenExitHintVisible}
            onReleaseVisible={revealFullscreenExitHint}
          />
        </>
      );
    }
    return (
      <div
        data-presentation-chrome="windowed"
        data-tauri-drag-region
        style={{
          height: "var(--h-titlebar)",
          background: "var(--terminal-canvas-bg, var(--c-bg-white))",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          WebkitAppRegion: "drag",
        } as DragStyle}
      >
        <PureModeActionStrip activeSessionId={activeSessionId} exitShortcut={presentationModeShortcut} />
        <div data-tauri-drag-region style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: _isMac ? 12 : 4, WebkitAppRegion: "no-drag" } as DragStyle}>
          {!_isMac && <WindowControls />}
        </div>
      </div>
    );
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "100%",
          boxSizing: "border-box",
          transform: titlebarControlTransform,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        {trafficLightWidth > 0 && <div style={{ width: trafficLightWidth, flexShrink: 0 }} />}
        {sessions.length > 0 && (
          <button
            onClick={onToggleSidebar}
            title={t("titlebar.toggle_sidebar")}
            aria-label={t("titlebar.toggle_sidebar")}
            aria-pressed={sidebarVisible}
            style={{
              width: "var(--w-titlebar-control)",
              height: "var(--h-titlebar-control)",
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
            <PanelLeftIcon active={sidebarVisible} />
          </button>
        )}
      </div>

      {deviceCaption && (
        <div
          role="status"
          data-titlebar-device={deviceCaption.key}
          data-titlebar-device-kind={deviceCaption.kind}
          title={deviceTitle}
          aria-label={deviceAccessibleName}
          style={{ ...deviceIdentityStyle, WebkitAppRegion: "drag" } as DragStyle}
        >
          <DeviceIdentityContent
            label={deviceCaption.label}
            kind={deviceCaption.kind}
            connectionPhase={deviceCaption.connectionPhase}
          />
        </div>
      )}

      <div style={{ flex: 1, display: "flex", alignItems: "center", paddingLeft: 4, transform: titlebarControlTransform, WebkitAppRegion: "no-drag" } as DragStyle}>
        <button
          onClick={openNewTerminalMenu}
          onContextMenu={openNewTerminalMenu}
          title={`${t("titlebar.new_menu")} · ${t("titlebar.new_terminal")} ${formatShortcut(newTerminalShortcut)}`}
          aria-label={t("titlebar.new_menu")}
          aria-haspopup="menu"
          aria-expanded={Boolean(newTerminalMenu)}
          style={{
            width: "var(--w-titlebar-control)",
            height: "var(--h-titlebar-control)",
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
          className="hover-bg"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingRight: 12,
          flexShrink: 0,
          transform: titlebarControlTransform,
          WebkitAppRegion: "no-drag",
        } as DragStyle}
      >
        <button
          ref={workspaceMenuBtnRef}
          type="button"
          onClick={openWorkspaceMenu}
          title={t("common.more_actions")}
          aria-label={t("common.more_actions")}
          aria-haspopup="menu"
          aria-expanded={workspaceMenu !== null}
          style={{
            width: "var(--w-titlebar-control)",
            height: "var(--h-titlebar-control)",
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
          <span aria-hidden="true" style={{ fontSize: 14, letterSpacing: -1 }}>•••</span>
        </button>

        {!_isMac && <WindowControls />}
      </div>
      {newTerminalMenu && (
        <ContextMenu
          items={newTerminalMenu.items}
          position={newTerminalMenu.position}
          onClose={() => setNewTerminalMenu(null)}
        />
      )}
      {workspaceMenu && (
        <ContextMenu
          items={workspaceMenu.items}
          position={workspaceMenu.position}
          onClose={() => setWorkspaceMenu(null)}
          returnFocusToken={workspaceMenuBtnRef}
        />
      )}
    </div>
  );
}

// Memoized: props are store primitives + module-level/useCallback-stable
// callbacks from App, so dragging the sidebar width no longer re-renders
// the titlebar (and its tabs) on every pointer frame.
export const Titlebar = memo(TitlebarImpl);
