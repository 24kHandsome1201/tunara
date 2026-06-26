import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { InspectorPanel } from "@/ui/InspectorPanel";
import { Settings } from "@/ui/overlays/Settings";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import { SshConnect } from "@/ui/overlays/SshConnect";
import { ToastContainer } from "@/ui/Toast";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useInit } from "./useInit";
import { useTheme } from "./useTheme";
import { useKeybindings } from "./useKeybindings";
import { useDockBadge } from "./useDockBadge";
import { useEffect } from "react";

// Module-level stable callbacks. These close over nothing render-scoped, so
// hoisting them keeps their identity constant across App re-renders — which
// lets the memoized Titlebar skip re-rendering when only unrelated state moved.
const closeSessionById = (id: string) => useSessionsStore.getState().closeSession(id);
const newTerminal = () => useSessionsStore.getState().newTerminal();
const openSettings = () => useUIStore.getState().setOverlay("settings");

interface ResizeHandleProps {
  edge: "left" | "right";
  getWidth: () => number;
  setWidth: (width: number) => void;
  direction: 1 | -1;
  className?: string;
}

function ResizeHandle({ edge, getWidth, setWidth, direction, className }: ResizeHandleProps) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = getWidth();

    const onPointerMove = (ev: PointerEvent) => {
      setWidth(startWidth + (ev.clientX - startX) * direction);
    };

    const cleanup = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) {
        handle.releasePointerCapture(ev.pointerId);
      }
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", cleanup);
      document.removeEventListener("pointercancel", cleanup);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", cleanup);
    document.addEventListener("pointercancel", cleanup);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={className}
      onPointerDown={onPointerDown}
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
  const setPanelWidth = useUIStore((s) => s.setPanelWidth);
  return (
    <ResizeHandle
      className="panel-resize-handle"
      edge="left"
      getWidth={() => useUIStore.getState().panelWidth}
      setWidth={setPanelWidth}
      direction={-1}
    />
  );
}

function SidebarResizeHandle() {
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  return (
    <ResizeHandle
      edge="right"
      getWidth={() => useUIStore.getState().sidebarWidth}
      setWidth={setSidebarWidth}
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
      }}
    >
      <span
        style={{
          fontSize: 20,
          fontWeight: 700,
          color: "var(--c-text-primary)",
          letterSpacing: "-0.012em",
          opacity: 0.8,
          animation: "breathe 1.6s ease-in-out infinite",
        }}
      >
        Tunara
      </span>
    </div>
  );
}

export default function App() {
  const ready = useUIStore((s) => s.ready);
  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const panelVisible = useUIStore((s) => s.panelVisible);
  const overlay = useUIStore((s) => s.overlay);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const panelWidth = useUIStore((s) => s.panelWidth);
  const viewportWidth = useUIStore((s) => s.viewportWidth);
  const setViewportWidth = useUIStore((s) => s.setViewportWidth);

  useInit();
  useTheme();
  useKeybindings();
  useDockBadge();

  useEffect(() => {
    const syncWidth = () => setViewportWidth(window.innerWidth);
    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, [setViewportWidth]);

  if (!ready) return <AppSplash />;

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const sidebarOverlay = viewportWidth < 720;
  const panelOverlay = viewportWidth < 900;
  const sidebarEffectiveWidth = sidebarVisible
    ? (sidebarOverlay ? Math.min(sidebarWidth, Math.max(240, viewportWidth * 0.86)) : sidebarWidth)
    : 0;
  const panelEffectiveWidth = panelVisible
    ? (panelOverlay ? Math.min(panelWidth, Math.max(220, viewportWidth - 24)) : panelWidth)
    : 0;


  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "var(--font-ui)",
        background: "var(--c-bg-white-glass)",
      }}
    >
      <Titlebar
        sessions={sessions}
        activeSessionId={activeSessionId ?? ""}
        panelVisible={panelVisible}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
        onSelectSession={setActive}
        onCloseSession={closeSessionById}
        onNewTerminal={newTerminal}
        onOpenSettings={openSettings}
      />

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, position: "relative" }}>
        {panelOverlay && panelVisible && (
          <div
            onClick={togglePanel}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 65,
              background: "var(--backdrop-color)",
              backdropFilter: "var(--backdrop-blur)",
              animation: "fadeIn var(--duration-fast) var(--ease-smooth)",
            }}
          />
        )}

        {sidebarOverlay && sidebarVisible && (
          <div
            onClick={toggleSidebar}
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 75,
              background: "var(--backdrop-color)",
              backdropFilter: "var(--backdrop-blur)",
              animation: "fadeIn var(--duration-fast) var(--ease-smooth)",
            }}
          />
        )}

        <div
          className="tunara-sidebar"
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
            boxShadow: sidebarOverlay && sidebarVisible ? "var(--shadow-overlay)" : undefined,
            transition: "width var(--duration-expand) var(--ease-out-expo)",
          }}
        >
          <Sidebar
            sessions={sessions}
            activeSessionId={activeSessionId ?? ""}
            onSelectSession={setActive}
            onNewTerminal={newTerminal}
            onCloseSession={closeSessionById}
          />
          {sidebarVisible && <SidebarResizeHandle />}
        </div>

        {sessions.length > 0 && (
          <MainArea
            sessions={sessions}
            activeSessionId={activeSessionId ?? ""}
          />
        )}

        {activeSession && (
          <div
            className="tunara-panel"
            style={{
              position: panelOverlay ? "absolute" : "relative",
              top: panelOverlay ? 0 : undefined,
              right: panelOverlay ? 0 : undefined,
              bottom: panelOverlay ? 0 : undefined,
              zIndex: panelOverlay ? 70 : undefined,
              boxShadow: panelOverlay && panelVisible ? "var(--shadow-overlay)" : undefined,
              width: panelEffectiveWidth,
              display: "flex",
              minHeight: 0,
              overflow: "hidden",
              transition: "width var(--duration-expand) var(--ease-out-expo)",
            }}
          >
            {panelVisible && <PanelResizeHandle />}
            <InspectorPanel session={activeSession} onClose={togglePanel} />
          </div>
        )}
      </div>

      {overlay === "settings" && <Settings onClose={() => setOverlay(null)} />}
      {overlay === "command-palette" && <CommandPalette onClose={() => setOverlay(null)} />}
      {overlay === "ssh" && <SshConnect onClose={() => setOverlay(null)} />}
      <ToastContainer />
    </div>
  );
}
