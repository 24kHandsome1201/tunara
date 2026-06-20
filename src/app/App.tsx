import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { InspectorPanel } from "@/ui/InspectorPanel";
import { Settings } from "@/ui/overlays/Settings";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useInit } from "./useInit";
import { useTheme } from "./useTheme";
import { useKeybindings } from "./useKeybindings";

function SidebarResizeHandle() {
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = useUIStore.getState().sidebarWidth;

    const onPointerMove = (ev: PointerEvent) => {
      setSidebarWidth(startWidth + ev.clientX - startX);
    };

    const onPointerUp = (ev: PointerEvent) => {
      (ev.target as HTMLElement).releasePointerCapture(ev.pointerId);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        right: -2,
        bottom: 0,
        width: 5,
        cursor: "col-resize",
        zIndex: 10,
      }}
    />
  );
}

export default function App() {
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

  useInit();
  useTheme();
  useKeybindings();

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

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
        onCloseSession={(id) => useSessionsStore.getState().closeSession(id)}
        onNewTerminal={() => useSessionsStore.getState().newTerminal()}
        onOpenSettings={() => setOverlay("settings")}
      />

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {sidebarVisible && (
          <div className="conduit-sidebar" style={{ display: "flex", minHeight: 0, overflow: "hidden", width: sidebarWidth, flexShrink: 0, position: "relative" }}>
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId ?? ""}
              onSelectSession={setActive}
              onNewTerminal={() => useSessionsStore.getState().newTerminal()}
              onCloseSession={(id) => useSessionsStore.getState().closeSession(id)}
            />
            <SidebarResizeHandle />
          </div>
        )}

        {sessions.length > 0 && (
          <MainArea
            sessions={sessions}
            activeSessionId={activeSessionId ?? ""}
          />
        )}

        {panelVisible && activeSession ? (
          <div className="conduit-panel">
            <InspectorPanel session={activeSession} onClose={togglePanel} />
          </div>
        ) : null}
      </div>

      {overlay === "settings" && <Settings onClose={() => setOverlay(null)} />}
      {overlay === "command-palette" && <CommandPalette onClose={() => setOverlay(null)} />}
    </div>
  );
}
