import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { InspectorPanel } from "@/ui/InspectorPanel";
import { Settings } from "@/ui/overlays/Settings";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import { SshConnect } from "@/ui/overlays/SshConnect";
import { HostKeyPromptDialog } from "@/ui/overlays/HostKeyPrompt";
import { KeyboardInteractivePromptDialog } from "@/ui/overlays/KeyboardInteractivePrompt";
import { WorkflowParamPrompt } from "@/ui/overlays/WorkflowParamPrompt";
import { ToastContainer } from "@/ui/Toast";
import { WorkspaceEmptyState } from "@/ui/WorkspaceEmptyState";
import { useT } from "@/modules/i18n";
import { t as staticT } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useEffect, useLayoutEffect, useRef } from "react";
import { openNewTerminalDirectoryDialog } from "@/modules/session/new-terminal-directory";
import {
  auxiliarySurfaceToCloseOnCompactResize,
  auxiliarySurfaceToCloseOnOpen,
  resolveAppShellLayout,
} from "./lib/app-shell-layout";
import { resolveResizeHandleWidth } from "./lib/resize-handle";
import { splitHorizontalPaneCount } from "@/modules/session/split-layout";
import { advanceTerminalFocusEpoch } from "@/modules/terminal/lib/binding-aware-async-action";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";
import { useAppServices } from "./useAppServices";

// Module-level stable callbacks. These close over nothing render-scoped, so
// hoisting them keeps their identity constant across App re-renders — which
// lets the memoized Titlebar skip re-rendering when only unrelated state moved.
const closeSessionById = (id: string) => useSessionsStore.getState().closeSession(id);
const newTerminal = () => useSessionsStore.getState().newTerminal();
const newTerminalInDirectory = () => { void openNewTerminalDirectoryDialog(); };
const openSettings = () => useUIStore.getState().openSettings();

// Same trick for the stacking-aware toggles: read the freshest layout input
// from the store at call time instead of closing over render-scope values,
// so the identities stay constant for the memoized Titlebar.
const currentLayoutInput = () => {
  const s = useUIStore.getState();
  return {
    viewportWidth: s.viewportWidth,
    sidebarVisible: s.sidebarVisible,
    panelVisible: s.panelVisible,
    sidebarWidth: s.sidebarWidth,
    panelWidth: s.panelWidth,
    terminalColumnCount: splitHorizontalPaneCount(s.split),
  };
};
const toggleSidebarWithoutStacking = () => {
  const s = useUIStore.getState();
  if (!s.sidebarVisible && auxiliarySurfaceToCloseOnOpen(currentLayoutInput(), "sidebar") === "panel") {
    s.setPanelVisible(false);
  }
  s.toggleSidebar();
};
const togglePanelWithoutStacking = () => {
  const s = useUIStore.getState();
  if (!s.panelVisible && auxiliarySurfaceToCloseOnOpen(currentLayoutInput(), "panel") === "sidebar") {
    s.setSidebarVisible(false);
  }
  s.togglePanel();
};

const WINDOW_RESIZE_EDGES = [
  ["North", "n"],
  ["NorthEast", "ne"],
  ["East", "e"],
  ["SouthEast", "se"],
  ["South", "s"],
  ["SouthWest", "sw"],
  ["West", "w"],
  ["NorthWest", "nw"],
] as const;

function WindowResizeHandles() {
  if (document.documentElement.dataset.chrome !== "borderless") return null;
  const win = tryGetCurrentWindow();
  if (!win) return null;

  return WINDOW_RESIZE_EDGES.map(([direction, edge]) => (
    <div
      key={direction}
      aria-hidden="true"
      className={`window-resize-handle window-resize-${edge}`}
      data-window-resize-direction={direction}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        void win.startResizeDragging(direction);
      }}
    />
  ));
}

interface ResizeHandleProps {
  edge: "left" | "right";
  getWidth: () => number;
  setWidth: (width: number) => void;
  minWidth: number;
  getMaxWidth: () => number;
  defaultWidth: number;
  ariaLabel: string;
  direction: 1 | -1;
  className?: string;
}

function ResizeHandle({ edge, getWidth, setWidth, minWidth, getMaxWidth, defaultWidth, ariaLabel, direction, className }: ResizeHandleProps) {
  // 拖拽中途组件被卸载时兜底摘掉 document 监听（否则监听器泄漏且光标卡死）
  const dragTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragTeardownRef.current?.(), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const width = resolveResizeHandleWidth({
      key: e.key,
      shiftKey: e.shiftKey,
      currentWidth: getWidth(),
      minWidth,
      maxWidth: getMaxWidth(),
      defaultWidth,
      direction,
    });
    if (width === null) return;
    e.preventDefault();
    setWidth(width);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = getWidth();

    const onPointerMove = (ev: PointerEvent) => {
      setWidth(startWidth + (ev.clientX - startX) * direction);
    };

    const teardown = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragTeardownRef.current = null;
    };

    const cleanup = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) {
        handle.releasePointerCapture(ev.pointerId);
      }
      teardown();
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
    dragTeardownRef.current = teardown;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={className}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuenow={Math.round(getWidth())}
      aria-valuemin={minWidth}
      aria-valuemax={Math.round(getMaxWidth())}
      aria-label={ariaLabel}
      style={{
        position: "absolute",
        top: 0,
        [edge]: -2,
        bottom: 0,
        width: 5,
        cursor: "col-resize",
        zIndex: 10,
      }}
    />
  );
}

function PanelResizeHandle() {
  const t = useT();
  const setPanelWidth = useUIStore((s) => s.setPanelWidth);
  return (
    <ResizeHandle
      className="panel-resize-handle"
      edge="left"
      getWidth={() => useUIStore.getState().panelWidth}
      setWidth={setPanelWidth}
      minWidth={240}
      getMaxWidth={() => Math.max(240, Math.floor(window.innerWidth * 0.45))}
      defaultWidth={320}
      ariaLabel={t("layout.resize.inspector")}
      direction={-1}
    />
  );
}

function SidebarResizeHandle() {
  const t = useT();
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  return (
    <ResizeHandle
      className="sidebar-resize-handle"
      edge="right"
      getWidth={() => useUIStore.getState().sidebarWidth}
      setWidth={setSidebarWidth}
      minWidth={200}
      getMaxWidth={() => 400}
      defaultWidth={272}
      ariaLabel={t("layout.resize.sidebar")}
      direction={1}
    />
  );
}

function AppSplash() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-ui)",
        background: "var(--c-bg-white)",
        animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        gap: 14,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: "var(--r-card)",
          background: "var(--c-accent-bg-light)",
          border: "1px solid var(--c-accent-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.9,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </div>
      <span
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--c-text-primary)",
          letterSpacing: "-0.012em",
          opacity: 0.86,
        }}
      >
        Tunara
      </span>
      {/* Keep cold-start legible without turning the wordmark into an
          ambient animation. */}
      <span
        style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-5)",
          fontFamily: "var(--font-mono)",
          opacity: 0.66,
        }}
      >
        {staticT("app.splash.restoring")}
      </span>
    </div>
  );
}

export default function App() {
  const t = useT();
  const ready = useUIStore((s) => s.ready);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const panelVisible = useUIStore((s) => s.panelVisible);
  const presentationMode = useUIStore((s) => s.presentationMode);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
  const overlay = useUIStore((s) => s.overlay);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const panelWidth = useUIStore((s) => s.panelWidth);
  const viewportWidth = useUIStore((s) => s.viewportWidth);
  const terminalColumnCount = useUIStore((s) => splitHorizontalPaneCount(s.split));
  const setViewportWidth = useUIStore((s) => s.setViewportWidth);

  useAppServices(ready, presentationMode === "pure");

  useEffect(() => {
    const syncWidth = () => setViewportWidth(window.innerWidth);
    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, [setViewportWidth]);

  useLayoutEffect(() => {
    if (presentationMode !== "workspace") return;
    const surface = auxiliarySurfaceToCloseOnCompactResize({
      viewportWidth,
      sidebarVisible,
      panelVisible,
      sidebarWidth,
      panelWidth,
      terminalColumnCount,
    });
    if (surface === "panel") useUIStore.getState().setPanelVisible(false);
  }, [panelVisible, panelWidth, presentationMode, sidebarVisible, sidebarWidth, terminalColumnCount, viewportWidth]);

  if (!ready) return <AppSplash />;

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const workspaceMode = presentationMode === "workspace";
  const presentedSidebarVisible = workspaceMode && sidebarVisible;
  const pureFilesVisible = !workspaceMode && panelVisible && inspectorTab === "files";
  const presentedPanelVisible = (workspaceMode && panelVisible) || pureFilesVisible;
  const {
    sidebarOverlay,
    panelOverlay,
    sidebarEffectiveWidth,
    panelEffectiveWidth,
    sidebarReservedWidth,
    panelReservedWidth,
  } = resolveAppShellLayout({
    viewportWidth,
    sidebarVisible: presentedSidebarVisible,
    panelVisible: presentedPanelVisible,
    sidebarWidth,
    panelWidth,
    terminalColumnCount,
  });

  return (
    <div
      data-presentation-mode={presentationMode}
      onPointerDownCapture={(event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target?.closest('[role="menu"], [role="listbox"]')) advanceTerminalFocusEpoch();
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "var(--font-ui)",
        background: workspaceMode ? "var(--c-bg-white)" : "var(--terminal-canvas-bg, var(--c-bg-white))",
      }}
    >
      <WindowResizeHandles />
      <Titlebar
        sessions={sessions}
        activeSessionId={activeSessionId ?? ""}
        panelVisible={panelVisible}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={toggleSidebarWithoutStacking}
        onTogglePanel={togglePanelWithoutStacking}
        onSelectSession={setActive}
        onCloseSession={closeSessionById}
        onNewTerminal={newTerminal}
        onNewTerminalInDirectory={newTerminalInDirectory}
        onOpenSettings={openSettings}
      />

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, position: "relative" }}>
        {sidebarOverlay && presentedSidebarVisible && (
          <div
            onClick={toggleSidebarWithoutStacking}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 75,
              background: "var(--backdrop-color)",
              animation: "fadeIn var(--duration-fast) var(--ease-smooth)",
            }}
          />
        )}

        <div
          className="tunara-sidebar"
          aria-hidden={presentedSidebarVisible ? undefined : true}
          inert={presentedSidebarVisible ? undefined : true}
          style={{
            display: "flex",
            minHeight: 0,
            overflow: "hidden",
            width: sidebarEffectiveWidth,
            flexShrink: 0,
            position: sidebarOverlay ? "absolute" : "relative",
            top: sidebarOverlay ? 0 : undefined,
            left: sidebarOverlay ? 0 : undefined,
            bottom: sidebarOverlay ? 0 : undefined,
            zIndex: sidebarOverlay ? 80 : undefined,
            boxShadow: sidebarOverlay && presentedSidebarVisible ? "var(--shadow-overlay)" : undefined,
            transition: workspaceMode ? "width var(--duration-expand) var(--ease-out-expo)" : "none",
          }}
        >
          {workspaceMode && (
            <>
              <Sidebar
                sessions={sessions}
                activeSessionId={activeSessionId ?? ""}
                onSelectSession={setActive}
                onNewTerminal={newTerminal}
                onNewTerminalInDirectory={newTerminalInDirectory}
                onCloseSession={closeSessionById}
              />
              {sidebarVisible && !sidebarOverlay && <SidebarResizeHandle />}
            </>
          )}
        </div>

        {sidebarOverlay && sidebarReservedWidth > 0 && (
          <div aria-hidden="true" style={{ width: sidebarReservedWidth, flexShrink: 0 }} />
        )}

        {sessions.length > 0 && (
          <MainArea
            key="terminal-main-area"
            sessions={sessions}
            activeSessionId={activeSessionId ?? ""}
          />
        )}

        {workspaceMode && sessions.length === 0 && (
          <WorkspaceEmptyState
            onNewTerminal={newTerminal}
            onNewTerminalInDirectory={newTerminalInDirectory}
            onOpenSsh={() => useUIStore.getState().openSshConnect()}
          />
        )}

        {activeSession && (
          <div
            className="tunara-panel"
            aria-hidden={presentedPanelVisible ? undefined : true}
            inert={presentedPanelVisible ? undefined : true}
            style={{
              position: panelOverlay ? "absolute" : "relative",
              top: panelOverlay ? 0 : undefined,
              right: panelOverlay ? 0 : undefined,
              bottom: panelOverlay ? 0 : undefined,
              zIndex: panelOverlay ? 80 : undefined,
              boxShadow: panelOverlay && presentedPanelVisible ? "var(--shadow-overlay)" : undefined,
              width: panelEffectiveWidth,
              display: "flex",
              minHeight: 0,
              overflow: "hidden",
              transition: workspaceMode ? "width var(--duration-expand) var(--ease-out-expo)" : "none",
            }}
          >
            {(workspaceMode || pureFilesVisible) && (
              <>
                {presentedPanelVisible && !panelOverlay && <PanelResizeHandle />}
                <InspectorPanel session={activeSession} filesOnly={!workspaceMode} onClose={() => useUIStore.getState().setPanelVisible(false)} />
              </>
            )}
          </div>
        )}

        {panelOverlay && panelReservedWidth > 0 && (
          <div aria-hidden="true" style={{ width: panelReservedWidth, flexShrink: 0 }} />
        )}
      </div>

      {workspaceMode && overlay === "settings" && <Settings onClose={() => setOverlay(null)} />}
      {overlay === "command-palette" && <CommandPalette onClose={() => setOverlay(null)} />}
      {workspaceMode && overlay === "ssh" && <SshConnect onClose={() => setOverlay(null)} />}
      <HostKeyPromptDialog />
      <KeyboardInteractivePromptDialog />
      {workspaceMode && <WorkflowParamPrompt />}
      <ToastContainer />
    </div>
  );
}
