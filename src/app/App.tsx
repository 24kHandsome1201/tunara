import { useCallback, useEffect, useRef } from "react";
import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { DiffPanel } from "@/ui/DiffPanel";
import { NotifCenter } from "@/ui/NotifCenter";
import { Settings } from "@/ui/overlays/Settings";
import { useSessionsStore, createSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { loadSessions, saveSessions } from "@/state/persist";
import { AGENT_NAMES } from "@/ui/types";

export default function App() {
  const { sessions, activeSessionId, addSession, removeSession, setActive, updateSession } =
    useSessionsStore();
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const panelVisible = useUIStore((s) => s.panelVisible);
  const overlay = useUIStore((s) => s.overlay);
  const notifOpen = useUIStore((s) => s.notifOpen);
  const notifications = useUIStore((s) => s.notifications);
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const toggleNotif = useUIStore((s) => s.toggleNotif);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const clearNotification = useUIStore((s) => s.clearNotification);
  const clearAllNotifications = useUIStore((s) => s.clearAllNotifications);

  const persistCurrentSessions = useCallback(() => {
    void saveSessions(useSessionsStore.getState().sessions);
  }, []);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    loadSessions().then((restored) => {
      for (const s of restored) addSession(s);
      if (restored.length === 0 && useSessionsStore.getState().sessions.length === 0) {
        addSession(createSession("~", { title: "终端" }));
      }
    });
  }, [addSession]);

  // ── 主题应用 ──
  useEffect(() => {
    const root = document.documentElement;
    const applyDark = (dark: boolean) => root.classList.toggle("dark", dark);
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      applyDark(mq.matches);
      const on = (e: MediaQueryListEvent) => applyDark(e.matches);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    }
    applyDark(theme === "dark");
  }, [theme]);

  // ── 强调色应用 ──
  useEffect(() => {
    document.documentElement.style.setProperty("--c-accent", accent);
  }, [accent]);

  const newTerminal = useCallback(() => {
    const st = useSessionsStore.getState();
    const active = st.sessions.find((s) => s.id === st.activeSessionId);
    addSession(createSession(active?.dir ?? "~", { title: "终端" }));
  }, [addSession]);

  const closeSession = useCallback(
    (id: string) => {
      removeSession(id);
      if (useSessionsStore.getState().sessions.length === 0) {
        addSession(createSession("~", { title: "终端" }));
      }
      persistCurrentSessions();
    },
    [addSession, persistCurrentSessions, removeSession],
  );

  // ── 全局快捷键 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "t" || k === "n") {
        e.preventDefault();
        newTerminal();
      } else if (k === "w") {
        e.preventDefault();
        const id = useSessionsStore.getState().activeSessionId;
        if (id) closeSession(id);
      } else if (k === ",") {
        e.preventDefault();
        useUIStore.getState().setOverlay("settings");
      } else if (k === "\\") {
        e.preventDefault();
        useUIStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [newTerminal, closeSession]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const unreadCount = notifications.length;

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
        unreadCount={unreadCount}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
        onToggleNotif={toggleNotif}
        onSelectSession={setActive}
        onCloseSession={closeSession}
        onOpenSettings={() => setOverlay("settings")}
      />

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {sidebarVisible && (
          <div className="conduit-sidebar" style={{ display: "flex", minHeight: 0, overflow: "hidden" }}>
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId ?? ""}
              onSelectSession={setActive}
              onNewTerminal={newTerminal}
              onCloseSession={closeSession}
            />
          </div>
        )}

        {sessions.length > 0 && (
          <MainArea
            sessions={sessions}
            activeSessionId={activeSessionId ?? ""}
            onAgentDetected={(sessionId, agent) => {
              updateSession(sessionId, { agent, title: AGENT_NAMES[agent] ?? agent });
            }}
            onAgentExited={(sessionId) => {
              updateSession(sessionId, { agent: undefined, title: "终端", lastCommand: undefined });
            }}
            onCommandDetected={(sessionId, command) => {
              updateSession(sessionId, { lastCommand: command });
            }}
            onCwd={(sessionId, cwd) => {
              const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
              const cwdChanged = session?.dir !== cwd;
              const lastCommand = session?.lastCommand?.trim() ?? "";
              updateSession(sessionId, {
                dir: cwd,
                ...(cwdChanged && /^(?:cd|pushd|popd)(?:\s|$)/.test(lastCommand)
                  ? { lastCommand: undefined }
                  : {}),
              });
            }}
            onShellTitle={(sessionId, shellTitle) => {
              updateSession(sessionId, { shellTitle });
            }}
          />
        )}

        {panelVisible && activeSession ? (
          <div className="conduit-panel">
            <DiffPanel session={activeSession} />
          </div>
        ) : null}
      </div>

      {notifOpen && (
        <NotifCenter
          notifications={notifications}
          onClose={() => toggleNotif()}
          onClear={(id) => clearNotification(id)}
          onClearAll={() => clearAllNotifications()}
          onSelect={(id) => setActive(id)}
        />
      )}

      {overlay === "settings" && <Settings onClose={() => setOverlay(null)} />}
    </div>
  );
}
