import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { InspectorPanel } from "@/ui/InspectorPanel";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import { HostKeyPromptDialog } from "@/ui/overlays/HostKeyPrompt";
import { KeyboardInteractivePromptDialog } from "@/ui/overlays/KeyboardInteractivePrompt";
import { ToastContainer } from "@/ui/Toast";
import { WorkspaceEmptyState } from "@/ui/WorkspaceEmptyState";
import { SshHostsDashboard } from "@/ui/SshHostsDashboard";
import { useT } from "@/modules/i18n";
import { t as staticT } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { PanelLoadingState } from "@/ui/shared";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
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
import { useChromeFade } from "./useChromeFade";
import { Icon, Terminal } from "@/ui/icons";

const Settings = lazy(() => import("@/ui/overlays/Settings").then((module) => ({ default: module.Settings })));
const SshConnect = lazy(() => import("@/ui/overlays/SshConnect").then((module) => ({ default: module.SshConnect })));

// Module-level stable callbacks. These close over nothing render-scoped, so
// hoisting them keeps their identity constant across App re-renders — which
// lets the memoized Titlebar skip re-rendering when only unrelated state moved.
const closeSessionById = (id: string) => useSessionsStore.getState().closeSession(id);
const selectSession = (id: string) => {
  useSessionsStore.getState().setActive(id);
  useUIStore.getState().showTerminal();
};
const newTerminal = () => {
  useUIStore.getState().showTerminal();
  useSessionsStore.getState().newTerminal();
};
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
  s.showTerminal();
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
        animation: "fadeIn var(--dur-base) var(--ease-out)",
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
        <Icon icon={Terminal} size={20} color="var(--c-accent)" weight="bold" />
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
  const ready = useUIStore((s) => s.ready);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const panelVisible = useUIStore((s) => s.panelVisible);
  const mainSurface = useUIStore((s) => s.mainSurface);
  const overlay = useUIStore((s) => s.overlay);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const panelWidth = useUIStore((s) => s.panelWidth);
  const viewportWidth = useUIStore((s) => s.viewportWidth);
  const terminalColumnCount = useUIStore((s) => splitHorizontalPaneCount(s.split));
  const setViewportWidth = useUIStore((s) => s.setViewportWidth);

  useAppServices(ready);
  const chromeFaded = useChromeFade();

  useEffect(() => {
    const syncWidth = () => setViewportWidth(window.innerWidth);
    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, [setViewportWidth]);

  useLayoutEffect(() => {
    const surface = auxiliarySurfaceToCloseOnCompactResize({
      viewportWidth,
      sidebarVisible,
      panelVisible,
      sidebarWidth,
      panelWidth,
      terminalColumnCount,
    });
    if (surface === "panel") useUIStore.getState().setPanelVisible(false);
  }, [panelVisible, panelWidth, sidebarVisible, sidebarWidth, terminalColumnCount, viewportWidth]);

  if (!ready) return <AppSplash />;

  const hasSessions = sessions.length > 0;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const terminalSurface = mainSurface === "terminal";
  const presentedSidebarVisible = hasSessions && sidebarVisible;
  const presentedPanelVisible = terminalSurface && panelVisible;
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
      className={chromeFaded ? "chrome-faded" : undefined}
      data-chrome-faded={chromeFaded ? "true" : undefined}
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
        background: "var(--c-bg-white)",
      }}
    >
      <WindowResizeHandles />
      <Titlebar
        sessions={sessions}
        activeSessionId={activeSessionId ?? ""}
        panelVisible={panelVisible}
        sidebarVisible={presentedSidebarVisible}
        onToggleSidebar={toggleSidebarWithoutStacking}
        onTogglePanel={togglePanelWithoutStacking}
        onSelectSession={selectSession}
        onCloseSession={closeSessionById}
        onNewTerminal={newTerminal}
        onNewTerminalInDirectory={newTerminalInDirectory}
        onOpenSettings={openSettings}
      />

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, position: "relative" }}>
        {sidebarOverlay && presentedSidebarVisible && (
          <div
            onClick={toggleSidebarWithoutStacking}
            className="overlay-backdrop"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 75,
              background: "var(--backdrop-color)",
            }}
          />
        )}

        <div
          className="tunara-sidebar"
          data-overlay={sidebarOverlay ? "true" : undefined}
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
          }}
        >
          {hasSessions && (
            <>
              <Sidebar
                sessions={sessions}
                activeSessionId={activeSessionId ?? ""}
                onSelectSession={selectSession}
                onNewTerminal={newTerminal}
                onNewTerminalInDirectory={newTerminalInDirectory}
                onCloseSession={closeSessionById}
              />
              {presentedSidebarVisible && !sidebarOverlay && <SidebarResizeHandle />}
            </>
          )}
        </div>

        {sidebarOverlay && sidebarReservedWidth > 0 && (
          <div aria-hidden="true" style={{ width: sidebarReservedWidth, flexShrink: 0 }} />
        )}

        {hasSessions && (
          <div style={{ flex: 1, display: terminalSurface ? "flex" : "none", minWidth: 0, minHeight: 0 }}>
            <MainArea
              key="terminal-main-area"
              sessions={sessions}
              activeSessionId={activeSessionId ?? ""}
            />
          </div>
        )}

        {mainSurface === "ssh-hosts" && <SshHostsDashboard sessions={sessions} />}

        {terminalSurface && !hasSessions && (
          <WorkspaceEmptyState
            onNewTerminal={newTerminal}
            onNewTerminalInDirectory={newTerminalInDirectory}
            onOpenSsh={() => useUIStore.getState().openSshConnect()}
          />
        )}

        {activeSession && terminalSurface && (
          <div
            className="tunara-panel"
            data-overlay={panelOverlay ? "true" : undefined}
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
            }}
          >
            <>
              {presentedPanelVisible && !panelOverlay && <PanelResizeHandle />}
              <InspectorPanel session={activeSession} onClose={() => useUIStore.getState().setPanelVisible(false)} />
            </>
          </div>
        )}

        {panelOverlay && panelReservedWidth > 0 && (
          <div aria-hidden="true" style={{ width: panelReservedWidth, flexShrink: 0 }} />
        )}
      </div>

      {overlay === "settings" && (
        <Suspense fallback={<PanelLoadingState label={staticT("diff.mini.loading")} />}>
          <Settings onClose={() => setOverlay(null)} />
        </Suspense>
      )}
      {overlay === "command-palette" && <CommandPalette onClose={() => setOverlay(null)} />}
      {overlay === "ssh" && (
        <Suspense fallback={<PanelLoadingState label={staticT("diff.mini.loading")} />}>
          <SshConnect onClose={() => setOverlay(null)} />
        </Suspense>
      )}
      <HostKeyPromptDialog />
      <KeyboardInteractivePromptDialog />
      <ToastContainer />
    </div>
  );
}
