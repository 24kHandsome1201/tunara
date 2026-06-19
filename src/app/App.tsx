// Conduit — 三栏外壳（接入 Zustand store + 真实终端/agent/git）

import { useCallback, useEffect, useRef } from "react";
import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { DiffPanel } from "@/ui/DiffPanel";
import { NotifCenter } from "@/ui/NotifCenter";
import { Settings } from "@/ui/overlays/Settings";
import { NewAgent } from "@/ui/overlays/NewAgent";
import { useSessionsStore, createSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { cancelAgent, preflightAgent, spawnAgent } from "@/modules/agent/agent-bridge";
import { loadSessions, saveSessions } from "@/state/persist";
import { AGENT_NAMES, type AgentCode, type AgentEvent } from "@/ui/types";

export default function App() {
  // ── Zustand stores ──
  const { sessions, activeSessionId, addSession, removeSession, setActive, applyEvent, appendReplyChunk, updateSession } =
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
  const addNotification = useUIStore((s) => s.addNotification);
  const clearNotification = useUIStore((s) => s.clearNotification);
  const clearAllNotifications = useUIStore((s) => s.clearAllNotifications);

  const pendingChunks = useRef<Map<string, string>>(new Map());
  const rafId = useRef<number | null>(null);
  const flushChunks = useCallback(() => {
    rafId.current = null;
    pendingChunks.current.forEach((chunk, sid) => {
      if (chunk) appendReplyChunk(sid, chunk);
    });
    pendingChunks.current.clear();
  }, [appendReplyChunk]);

  const persistCurrentSessions = useCallback(() => {
    void saveSessions(useSessionsStore.getState().sessions);
  }, []);

  const handleAgentEvent = useCallback(
    (sessionId: string, ev: AgentEvent) => {
      if (ev.kind === "delta") {
        const prev = pendingChunks.current.get(sessionId) ?? "";
        pendingChunks.current.set(sessionId, prev + ev.text);
        if (rafId.current == null) {
          rafId.current = requestAnimationFrame(flushChunks);
        }
        return;
      }

      applyEvent(sessionId, ev);
      if (ev.kind === "done" || ev.kind === "failed") {
        const store = useSessionsStore.getState();
        void saveSessions(store.sessions);
        store.refreshGit(sessionId);
        const session = store.sessions.find((s) => s.id === sessionId);
        const title = session?.title ?? "Agent";
        addNotification({
          id: crypto.randomUUID(),
          type: ev.kind === "failed" || (ev.kind === "done" && !ev.ok) ? "error" : "success",
          message: ev.kind === "failed" ? ev.message : ev.ok ? "已完成" : "执行失败",
          sessionTitle: title,
          sessionId,
        });
      }
    },
    [addNotification, applyEvent, flushChunks],
  );

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    loadSessions().then((restored) => {
      for (const s of restored) addSession(s);
      if (restored.length === 0 && useSessionsStore.getState().sessions.length === 0) {
        addSession(createSession("shell", "~", { title: "终端" }));
      }
    });
  }, [addSession]);

  // ── 主题应用：切换 .dark class + 跟随系统 ──
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

  // ── 强调色应用（暗色 accent 由 tokens.css .dark 控制） ──
  useEffect(() => {
    document.documentElement.style.setProperty("--c-accent", accent);
  }, [accent]);

  // ── 操作：新建终端 / 关闭会话 ──
  const newTerminal = useCallback(() => {
    const st = useSessionsStore.getState();
    const active = st.sessions.find((s) => s.id === st.activeSessionId);
    addSession(createSession("shell", active?.dir ?? "~", { title: "终端" }));
  }, [addSession]);

  const closeSession = useCallback(
    (id: string) => {
      const st = useSessionsStore.getState();
      const s = st.sessions.find((x) => x.id === id);
      if (s?.kind === "agent" && s.runState === "running" && s.procId != null) {
        cancelAgent(s.procId).catch(() => {});
      }
      removeSession(id);
      if (useSessionsStore.getState().sessions.length === 0) {
        addSession(createSession("shell", "~", { title: "终端" }));
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
      if (k === "t") {
        e.preventDefault();
        newTerminal();
      } else if (k === "n") {
        e.preventDefault();
        useUIStore.getState().setOverlay("agent");
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
              onNewAgent={() => setOverlay("agent")}
            />
          </div>
        )}

        {sessions.length > 0 && (
          <MainArea
            sessions={sessions}
            activeSessionId={activeSessionId ?? ""}
            onViewDiff={() => {
              if (!panelVisible) togglePanel();
            }}
            onAgentDetected={(sessionId, agent) => {
              updateSession(sessionId, { agent, title: AGENT_NAMES[agent] ?? agent });
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
      {overlay === "agent" && (
        <NewAgent
          defaultDir={activeSession?.dir ?? "~"}
          onClose={() => setOverlay(null)}
          onCreate={(agent, dir, prompt) => {
            const agentCode = agent as AgentCode;
            const s = createSession("agent", dir, {
              agent: agentCode,
              title: prompt.slice(0, 60),
              prompt,
            });
            addSession(s);
            preflightAgent(agentCode)
              .then((pf) => {
                if (!pf.installed || !pf.loggedIn) {
                  handleAgentEvent(s.id, {
                    kind: "failed",
                    message: pf.hint ?? `${agentCode} 未安装或未登录`,
                  });
                  return;
                }
                spawnAgent(agentCode, prompt, dir, undefined, (ev) => handleAgentEvent(s.id, ev))
                  .then((procId) => updateSession(s.id, { procId }))
                  .catch((err) => handleAgentEvent(s.id, { kind: "failed", message: String(err) }));
              })
              .catch((err) => handleAgentEvent(s.id, { kind: "failed", message: String(err) }));
          }}
        />
      )}
    </div>
  );
}
