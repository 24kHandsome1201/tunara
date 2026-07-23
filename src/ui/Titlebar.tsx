import { useCallback, useEffect, useRef, useState } from "react";
import { deriveTitle, type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { getNumberRecordValue } from "@/state/record-keys";
import { useUIStore } from "@/state/ui";
import { formatShortcut } from "./formatShortcut";
import { platform } from "@tauri-apps/plugin-os";
import { CloseIcon } from "./shared";
import { useT } from "@/modules/i18n";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { SessionMascotIcon } from "./SessionMascotIcon";
import type { WorkspaceFileTab } from "@/state/ui";
import { requestDirtyDraftFileAction } from "@/modules/editor/dirty-draft-guard";

let _isMac = true;
try { _isMac = platform() === "macos"; } catch { _isMac = navigator.platform.toLowerCase().includes("mac"); }

// WebKit's `-webkit-app-region` CSS property is not in the standard
// React.CSSProperties type. Model just the one vendor extension we use.
type DragStyle = React.CSSProperties & { WebkitAppRegion?: string };

const TITLEBAR_ICON_STYLE: React.CSSProperties = { width: 16, height: 16, flexShrink: 0 };
const MAC_TITLEBAR_CONTROL_Y_OFFSET = -1;
const FULLSCREEN_EXIT_HINT_DURATION_MS = 4000;

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

function GearIcon() {
  return (
    <svg style={TITLEBAR_ICON_STYLE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
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
  visible = true,
  onKeepVisible,
  onReleaseVisible,
}: PresentationModeButtonProps) {
  const accessibleLabel = `${label} ${shortcut}`;
  return (
    <button
      type="button"
      data-presentation-action={floating ? "exit-fullscreen-pure" : undefined}
      data-visible={floating ? String(visible) : undefined}
      onClick={onClick}
      onPointerEnter={onKeepVisible}
      onPointerLeave={onReleaseVisible}
      onFocus={onKeepVisible}
      onBlur={onReleaseVisible}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      aria-hidden={floating && !visible ? true : undefined}
      tabIndex={floating && !visible ? -1 : 0}
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
        ...(floating ? {
          position: "fixed",
          top: 8,
          left: "50%",
          zIndex: 900,
          opacity: visible ? 1 : 0,
          transform: `translate(-50%, ${visible ? "0" : "-8px"})`,
          pointerEvents: visible ? "auto" : "none",
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

interface TabButtonProps {
  isActive: boolean;
  label: string;
  kind: "terminal" | "file";
  dirty?: boolean;
  mascot?: Session["mascot"];
  dirtyLabel: string;
  closeLabel: string;
  confirmCloseLabel: string;
  confirmClose?: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function WorkspaceTabIcon({ kind }: { kind: "terminal" | "file" }) {
  if (kind === "terminal") {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" />
        <path d="m4.25 5 2 2-2 2M8 10h3.5" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M4 1.75h5l3 3v9.5H4z" />
      <path d="M9 1.75v3h3" />
    </svg>
  );
}

function TabButton({ isActive, label, kind, dirty, mascot, dirtyLabel, closeLabel, confirmCloseLabel, confirmClose, onSelect, onClose }: TabButtonProps) {
  return (
    <div
      className="tab-btn"
      data-workspace-tab-kind={kind}
      data-active={isActive ? "true" : "false"}
      style={{
        height: 28,
        borderRadius: "var(--r-pill)",
        background: isActive ? "var(--c-accent-bg-soft)" : "transparent",
        display: "flex",
        alignItems: "center",
        flexShrink: 0,
        transition: "background var(--duration-fast) ease",
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        onClick={onSelect}
        className="tab-select"
        style={{
          height: "100%",
          padding: "0 5px 0 10px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 5,
          color: "inherit",
          borderRadius: "var(--r-pill) 0 0 var(--r-pill)",
        }}
      >
        {kind === "terminal" && mascot
          ? <SessionMascotIcon id={mascot} size={18} />
          : <WorkspaceTabIcon kind={kind} />}
        <span style={{
          fontSize: "var(--fs-secondary)",
          fontWeight: isActive ? 600 : 400,
          color: isActive ? "var(--c-text-primary)" : "var(--c-text-4)",
          fontFamily: "var(--font-ui)",
          transition: "color var(--duration-fast) var(--ease-smooth), font-weight var(--duration-fast) var(--ease-smooth)",
        }}>
          {label}
        </span>
        {dirty && <span className="workspace-tab-dirty" aria-label={dirtyLabel} />}
      </button>
      <button
        type="button"
        tabIndex={0}
        title={confirmClose ? confirmCloseLabel : closeLabel}
        aria-label={confirmClose ? confirmCloseLabel : closeLabel}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
        className="tab-close hover-close"
        style={{
          width: 20, height: 20, borderRadius: 5, border: "none", background: "transparent",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          cursor: "pointer", padding: 0, marginRight: 4,
          color: confirmClose ? "var(--c-error)" : undefined,
        }}
      >
        <CloseIcon size={10} strokeWidth={2.2} />
      </button>
    </div>
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

export function Titlebar({
  sessions,
  activeSessionId,
  panelVisible,
  sidebarVisible,
  onToggleSidebar,
  onTogglePanel,
  onSelectSession,
  onCloseSession,
  onNewTerminal,
  onNewTerminalInDirectory,
  onOpenSettings,
}: TitlebarProps) {
  const t = useT();
  const presentationMode = useUIStore((s) => s.presentationMode);
  const nativeFullscreen = useUIStore((s) => s.nativeFullscreen);
  const fileTabs = useUIStore((s) => s.fileTabs);
  const activeFileTabId = useUIStore((s) => s.activeFileTabId);
  const setActiveFileTab = useUIStore((s) => s.setActiveFileTab);
  const closeFileTab = useUIStore((s) => s.closeFileTab);
  const showTabs = presentationMode === "workspace" && (!sidebarVisible || fileTabs.length > 0);
  const trafficLightWidth = useUIStore((s) => s.trafficLightWidth);
  const closeConfirmations = useSessionsStore((s) => s.closeConfirmations);
  const newTerminalShortcut = useUIStore((s) => s.keybindings.newTerminal);
  const openSettingsShortcut = useUIStore((s) => s.keybindings.openSettings);
  const closeSessionShortcut = useUIStore((s) => s.keybindings.closeSession);
  const presentationModeBinding = useUIStore((s) => s.keybindings.togglePresentationMode);
  const presentationModeShortcut = formatShortcut(presentationModeBinding);
  const setPresentationMode = useUIStore((s) => s.setPresentationMode);
  const tabsRef = useRef<HTMLDivElement>(null);
  const fullscreenHintTimerRef = useRef<number | null>(null);
  const [fullscreenExitHintVisible, setFullscreenExitHintVisible] = useState(false);
  const [overflowEdge, setOverflowEdge] = useState<"none" | "left" | "right" | "both">("none");
  const [newTerminalMenu, setNewTerminalMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    if (presentationMode === "pure") setNewTerminalMenu(null);
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
    setNewTerminalMenu({
      position: { x: event.clientX, y: event.clientY },
      items: [
        { id: "new-terminal", label: t("titlebar.new_terminal"), icon: "terminal", action: onNewTerminal },
        { id: "new-terminal-directory", label: t("titlebar.new_terminal_in_directory"), icon: "folder", action: onNewTerminalInDirectory },
      ],
    });
  };

  function tabLabel(s: Session): string {
    const { primary } = deriveTitle(s);
    return primary.length > 24 ? primary.slice(0, 24) + "…" : primary;
  }

  function fileTabLabel(tab: WorkspaceFileTab): string {
    return tab.fileName.length > 28 ? tab.fileName.slice(0, 28) + "…" : tab.fileName;
  }

  function selectFileTab(tab: WorkspaceFileTab) {
    useSessionsStore.getState().setActive(tab.sessionId);
    setActiveFileTab(tab.id);
  }

  function requestCloseFileTab(tab: WorkspaceFileTab) {
    const close = () => {
      const wasActive = useUIStore.getState().activeFileTabId === tab.id;
      closeFileTab(tab.id);
      if (!wasActive) return;
      const ui = useUIStore.getState();
      const adjacent = ui.fileTabs.find((candidate) => candidate.id === ui.activeFileTabId);
      if (!adjacent) return;
      useSessionsStore.getState().setActive(adjacent.sessionId);
      ui.setActiveFileTab(adjacent.id);
    };
    if (requestDirtyDraftFileAction(tab.sessionId, tab.filePath, close)) close();
  }

  // 监听 tabs 容器滚动，决定哪边显示渐隐提示
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !showTabs) return;
    const update = () => {
      const canLeft = el.scrollLeft > 1;
      const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setOverflowEdge(canLeft && canRight ? "both" : canLeft ? "left" : canRight ? "right" : "none");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [showTabs, sessions.length, fileTabs.length]);

  // 鼠标滚轮 → 横向滚动（trackpad 横滑天生工作，无需介入）
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !showTabs) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return; // trackpad 横滑，浏览器已经处理
      if (e.deltaY === 0) return;
      const maxScroll = el.scrollWidth - el.clientWidth;
      if (maxScroll <= 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [showTabs]);

  // active tab 自动滚入视野
  useEffect(() => {
    const el = tabsRef.current;
    if (!el || !showTabs) return;
    const active = el.querySelector<HTMLElement>('[data-active-tab="true"]');
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 16);
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 16;
  }, [activeFileTabId, activeSessionId, showTabs, sessions.length, fileTabs.length]);

  const tabsMask =
    overflowEdge === "both"
      ? "linear-gradient(to right, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)"
      : overflowEdge === "left"
        ? "linear-gradient(to right, transparent 0, #000 24px)"
        : overflowEdge === "right"
          ? "linear-gradient(to right, #000 calc(100% - 24px), transparent 100%)"
          : undefined;
  const titlebarControlTransform = _isMac ? `translateY(${MAC_TITLEBAR_CONTROL_Y_OFFSET}px)` : undefined;

  if (presentationMode === "pure") {
    if (nativeFullscreen) {
      return (
        <PresentationModeButton
          label={t("palette.cmd.exit_pure")}
          shortcut={presentationModeShortcut}
          onClick={() => setPresentationMode("workspace")}
          showShortcut
          floating
          visible={fullscreenExitHintVisible}
          onKeepVisible={keepFullscreenExitHintVisible}
          onReleaseVisible={revealFullscreenExitHint}
        />
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
        <div data-tauri-drag-region style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: _isMac ? 12 : 4, WebkitAppRegion: "no-drag" } as DragStyle}>
          <PresentationModeButton
            label={t("palette.cmd.exit_pure")}
            shortcut={presentationModeShortcut}
            onClick={() => setPresentationMode("workspace")}
            showShortcut
            surface
          />
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
      </div>

      {showTabs ? (
        <div
          ref={tabsRef}
          role="tablist"
          aria-label={t("titlebar.tabs")}
          className="no-scrollbar"
          style={{
            display: "flex",
            alignItems: "center",
            height: "100%",
            gap: 6,
            paddingLeft: 8,
            flex: 1,
            overflowX: "auto",
            overflowY: "hidden",
            animation: "tabsIn var(--duration-normal) var(--ease-out-expo)",
            transform: titlebarControlTransform,
            WebkitAppRegion: "no-drag",
            maskImage: tabsMask,
            WebkitMaskImage: tabsMask,
          } as DragStyle}
        >
          {sessions.map((s) => (
            <div key={`terminal:${s.id}`} data-tab-id={`terminal:${s.id}`} data-active-tab={activeFileTabId === null && s.id === activeSessionId ? "true" : undefined} style={{ flexShrink: 0 }}>
              <TabButton
                isActive={activeFileTabId === null && s.id === activeSessionId}
                label={tabLabel(s)}
                kind="terminal"
                mascot={s.mascot}
                dirtyLabel={t("preview.editor.unsaved")}
                closeLabel={`${t("titlebar.tab.close")} ${formatShortcut(closeSessionShortcut)}`}
                confirmCloseLabel={t("destructive.confirm_again.close")}
                confirmClose={getNumberRecordValue(closeConfirmations, s.id) > 0}
                onSelect={() => onSelectSession(s.id)}
                onClose={() => onCloseSession(s.id)}
              />
            </div>
          ))}
          {fileTabs.map((tab) => (
            <div key={`file:${tab.id}`} data-tab-id={`file:${tab.id}`} data-active-tab={tab.id === activeFileTabId ? "true" : undefined} style={{ flexShrink: 0 }}>
              <TabButton
                isActive={tab.id === activeFileTabId}
                label={fileTabLabel(tab)}
                kind="file"
                dirty={tab.dirty}
                dirtyLabel={t("preview.editor.unsaved")}
                closeLabel={t("titlebar.file_tab.close", { file: tab.fileName })}
                confirmCloseLabel={t("preview.editor.close_warning")}
                onSelect={() => selectFileTab(tab)}
                onClose={() => requestCloseFileTab(tab)}
              />
            </div>
          ))}
          <button
            onClick={onNewTerminal}
            onContextMenu={openNewTerminalMenu}
            title={`${t("titlebar.new_terminal")} ${formatShortcut(newTerminalShortcut)}`}
            aria-label={`${t("titlebar.new_terminal")} ${formatShortcut(newTerminalShortcut)}`}
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
          <button
            type="button"
            onClick={onNewTerminalInDirectory}
            title={t("titlebar.new_terminal_in_directory")}
            aria-label={t("titlebar.new_terminal_in_directory")}
            className="hover-bg"
            style={{
              width: "var(--w-titlebar-control)",
              height: "var(--h-titlebar-control)",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "transparent",
              color: "var(--c-text-4)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              <path d="M3 9h18" />
            </svg>
          </button>
        </div>
      ) : (
        <div style={{ flex: 1 }} />
      )}

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
        <PresentationModeButton
          label={t("titlebar.pure_mode")}
          shortcut={presentationModeShortcut}
          onClick={() => setPresentationMode("pure")}
        />

        <button
          onClick={onOpenSettings}
          title={`${t("titlebar.settings")} ${formatShortcut(openSettingsShortcut)}`}
          aria-label={`${t("titlebar.settings")} ${formatShortcut(openSettingsShortcut)}`}
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
          <GearIcon />
        </button>

        <button
          onClick={onTogglePanel}
          title={panelVisible ? t("titlebar.panel.hide") : t("titlebar.panel.show")}
          aria-label={panelVisible ? t("titlebar.panel.hide") : t("titlebar.panel.show")}
          aria-pressed={panelVisible}
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
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: panelVisible ? "var(--c-accent)" : undefined, transition: "color var(--duration-fast) ease" }}>
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" />
            <rect x="9" y="1.5" width="5.5" height="13" rx="2" fill={panelVisible ? "currentColor" : "none"} fillOpacity="0.3" stroke="currentColor" strokeWidth="1.2" />
          </svg>
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
    </div>
  );
}
