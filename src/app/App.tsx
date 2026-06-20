import { useCallback, useEffect, useRef } from "react";
import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { DiffPanel } from "@/ui/DiffPanel";
import { Settings } from "@/ui/overlays/Settings";
import { CommandPalette } from "@/ui/overlays/CommandPalette";
import { useSessionsStore, createSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { loadSessions, saveSessions, loadUILayout, saveUILayout } from "@/state/persist";
import { AGENT_NAMES } from "@/ui/types";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";

export default function App() {
  const { sessions, activeSessionId, addSession, removeSession, setActive, updateSession } =
    useSessionsStore();
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const panelVisible = useUIStore((s) => s.panelVisible);
  const overlay = useUIStore((s) => s.overlay);
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const setOverlay = useUIStore((s) => s.setOverlay);

  const persistCurrentSessions = useCallback(() => {
    const st = useSessionsStore.getState();
    void saveSessions(st.sessions, st.activeSessionId);
  }, []);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    loadSessions().then(({ sessions: restored, activeSessionId: restoredActive }) => {
      for (const s of restored) addSession(s);
      if (restored.length === 0 && useSessionsStore.getState().sessions.length === 0) {
        addSession(createSession("~", { title: "终端" }));
      } else if (restoredActive) {
        const exists = useSessionsStore.getState().sessions.some((s) => s.id === restoredActive);
        if (exists) setActive(restoredActive);
      }
    });

    loadUILayout().then((layout) => {
      if (!layout) return;
      const ui = useUIStore.getState();
      if (layout.sidebarVisible !== ui.sidebarVisible) ui.toggleSidebar();
      if (layout.panelVisible !== ui.panelVisible) ui.togglePanel();
    });

    try {
      const p = platform();
      const isMac = p === "macos";
      const setTL = (fs: boolean) =>
        useUIStore.getState().setTrafficLightWidth(isMac && !fs ? 96 : 0);

      const win = getCurrentWindow();
      win.isFullscreen().then((fs) => setTL(fs));

      if (isMac) {
        let pending = false;
        const check = () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            win.isFullscreen().then((fs) => setTL(fs));
            pending = false;
          });
        };
        win.onResized(check);
      }
    } catch {
      useUIStore.getState().setTrafficLightWidth(96);
    }

    // close-requested: persist before window closes
    getCurrentWindow()
      .onCloseRequested(async () => {
        const st = useSessionsStore.getState();
        const ui = useUIStore.getState();
        await saveSessions(st.sessions, st.activeSessionId);
        await saveUILayout({ sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible });
      })
      .catch(() => {});

    // Auto-persist on any sessions mutation (reference equality check)
    let prevSessions = useSessionsStore.getState().sessions;
    const unsub = useSessionsStore.subscribe((state) => {
      if (state.sessions !== prevSessions) {
        prevSessions = state.sessions;
        void saveSessions(state.sessions, state.activeSessionId);
      }
    });

    // 30s periodic save as fallback
    const timer = setInterval(() => {
      const st = useSessionsStore.getState();
      void saveSessions(st.sessions, st.activeSessionId);
    }, 30_000);
    return () => { unsub(); clearInterval(timer); };
  }, [addSession, setActive]);

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
    persistCurrentSessions();
  }, [addSession, persistCurrentSessions]);

  const closeSession = useCallback(
    (id: string) => {
      const ui = useUIStore.getState();
      if (ui.split.paneB === id) ui.closeSplit();
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
        const ui = useUIStore.getState();
        if (ui.split.mode !== "single" && ui.split.paneB) {
          const paneBId = ui.split.paneB;
          ui.closeSplit();
          removeSession(paneBId);
          if (useSessionsStore.getState().sessions.length === 0) {
            addSession(createSession("~", { title: "终端" }));
          }
        } else {
          const id = useSessionsStore.getState().activeSessionId;
          if (id) closeSession(id);
        }
      } else if (k === ",") {
        e.preventDefault();
        useUIStore.getState().setOverlay("settings");
      } else if (k === "\\") {
        e.preventDefault();
        if (e.shiftKey) {
          useUIStore.getState().togglePanel();
        } else {
          useUIStore.getState().toggleSidebar();
        }
      } else if (k === "d") {
        e.preventDefault();
        const st = useSessionsStore.getState();
        const ui = useUIStore.getState();
        if (ui.split.mode !== "single") return;
        const newSess = createSession(
          st.sessions.find((s) => s.id === st.activeSessionId)?.dir ?? "~",
          { title: "终端" },
        );
        addSession(newSess);
        if (e.shiftKey) {
          ui.splitVertical(newSess.id);
        } else {
          ui.splitHorizontal(newSess.id);
        }
      } else if (k === "]" || k === "[") {
        e.preventDefault();
        const ui = useUIStore.getState();
        const st = useSessionsStore.getState();
        if (ui.split.mode !== "single" && ui.split.paneB) {
          if (st.activeSessionId === ui.split.paneB) {
            const sessions = st.sessions;
            const nonPaneB = sessions.find((s) => s.id !== ui.split.paneB);
            if (nonPaneB) setActive(nonPaneB.id);
          } else {
            setActive(ui.split.paneB);
          }
        }
      } else if (k === "k") {
        e.preventDefault();
        useUIStore.getState().setOverlay("command-palette");
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [newTerminal, closeSession, addSession, setActive]);

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
        onCloseSession={closeSession}
        onNewTerminal={newTerminal}
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
              updateSession(sessionId, { agent, title: AGENT_NAMES[agent] ?? agent, runState: "running", startedAt: Date.now(), completedAt: undefined });
            }}
            onAgentExited={(sessionId, exitCode) => {
              updateSession(sessionId, { agent: undefined, title: "终端", lastCommand: undefined, runState: exitCode === 0 ? "done" : "failed", completedAt: Date.now() });
              useSessionsStore.getState().refreshGit(sessionId);
            }}
            onCommandDetected={(sessionId, command) => {
              updateSession(sessionId, { lastCommand: command, runState: "running", startedAt: Date.now() });
            }}
            onCommandFinished={(sessionId, exitCode) => {
              updateSession(sessionId, {
                lastExitCode: exitCode,
                runState: exitCode === 0 ? "done" : "failed",
                completedAt: Date.now(),
              });
              useSessionsStore.getState().refreshGit(sessionId);
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
              if (cwdChanged) persistCurrentSessions();
            }}
            onShellTitle={(sessionId, shellTitle) => {
              updateSession(sessionId, { shellTitle });
            }}
          />
        )}

        {panelVisible && activeSession ? (
          <div className="conduit-panel">
            <DiffPanel session={activeSession} onClose={togglePanel} />
          </div>
        ) : null}
      </div>

      {overlay === "settings" && <Settings onClose={() => setOverlay(null)} />}
      {overlay === "command-palette" && <CommandPalette onClose={() => setOverlay(null)} />}
    </div>
  );
}
