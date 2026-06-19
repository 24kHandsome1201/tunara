// Conduit — 三栏外壳（接入 Zustand store + 真实终端/agent/git）

import { useCallback, useEffect, useRef } from "react";
import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { MainArea } from "@/ui/MainArea";
import { DiffPanel } from "@/ui/DiffPanel";
import { NotifCenter } from "@/ui/NotifCenter";
import { NewAgent } from "@/ui/overlays/NewAgent";
import { Settings } from "@/ui/overlays/Settings";
import { useSessionsStore, createSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { spawnAgent, preflightAgent, cancelAgent } from "@/modules/agent/agent-bridge";
import { loadSessions, saveSessions } from "@/state/persist";
import type { AgentCode, AgentEvent } from "@/ui/types";

function lightenForDark(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  l = Math.min(0.75, l + 0.15);
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(hue2rgb(p, q, h + 1/3))}${toHex(hue2rgb(p, q, h))}${toHex(hue2rgb(p, q, h - 1/3))}`;
}

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
  const agentPick = useUIStore((s) => s.agentPick);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const toggleNotif = useUIStore((s) => s.toggleNotif);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const setAgentPick = useUIStore((s) => s.setAgentPick);
  const addNotification = useUIStore((s) => s.addNotification);
  const clearNotification = useUIStore((s) => s.clearNotification);
  const clearAllNotifications = useUIStore((s) => s.clearAllNotifications);

  // ── chunk + rAF 打字机（§4.4 修 P2-14）──
  const pendingChunks = useRef<Map<string, string>>(new Map());
  const rafId = useRef<number | null>(null);
  const flushChunks = useCallback(() => {
    rafId.current = null;
    pendingChunks.current.forEach((chunk, sid) => {
      if (chunk) appendReplyChunk(sid, chunk);
    });
    pendingChunks.current.clear();
  }, [appendReplyChunk]);

  const handleAgentEvent = useCallback(
    (sessionId: string, ev: AgentEvent) => {
      if (ev.kind === "delta") {
        const prev = pendingChunks.current.get(sessionId) ?? "";
        pendingChunks.current.set(sessionId, prev + ev.text);
        if (rafId.current == null) {
          rafId.current = requestAnimationFrame(flushChunks);
        }
      } else {
        applyEvent(sessionId, ev);
        if (ev.kind === "done" || ev.kind === "failed") {
          const store = useSessionsStore.getState();
          saveSessions(store.sessions);
          store.refreshGit(sessionId); // 终态后刷新 diff 面板
          const session = store.sessions.find((s) => s.id === sessionId);
          const title = session?.title ?? "Agent";
          if (ev.kind === "failed") {
            addNotification({ id: crypto.randomUUID(), type: "error", message: ev.message, sessionTitle: title, sessionId });
          } else if (ev.kind === "done" && ev.ok) {
            addNotification({ id: crypto.randomUUID(), type: "success", message: "已完成", sessionTitle: title, sessionId });
          }
        }
      }
    },
    [applyEvent, flushChunks, addNotification],
  );

  // M7 启动时加载持久化的已结束会话 + 若无会话则自动创建 shell
  useEffect(() => {
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

  // ── 强调色应用（暗色模式自动提亮） ──
  useEffect(() => {
    const isDark = theme === "dark" || (theme === "system" && (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false));
    const effective = isDark ? lightenForDark(accent) : accent;
    document.documentElement.style.setProperty("--c-accent", effective);
  }, [accent, theme]);

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
    },
    [addSession, removeSession],
  );

  // ── 全局快捷键 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
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
      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes pulseDot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } }
        @keyframes toastIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes sheetIn { from { opacity: 0; transform: translate(-50%, -52%); } to { opacity: 1; transform: translate(-50%, -50%); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
        @media (max-width: 900px) { .conduit-panel { display: none !important; } }
        @media (max-width: 720px) { .conduit-sidebar { display: none !important; } }
      `}</style>

      <Titlebar
        sessions={sessions}
        activeSessionId={activeSessionId ?? ""}
        sidebarVisible={sidebarVisible}
        panelVisible={panelVisible}
        notifOpen={notifOpen}
        unreadCount={unreadCount}
        onToggleSidebar={toggleSidebar}
        onTogglePanel={togglePanel}
        onToggleNotif={toggleNotif}
        onSelectSession={setActive}
        onCloseSession={closeSession}
        onNewAgent={() => setOverlay("agent")}
      />

      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
        {sidebarVisible && (
          <div className="conduit-sidebar">
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId ?? ""}
              onSelectSession={setActive}
              onNewTerminal={newTerminal}
              onNewAgent={() => setOverlay("agent")}
              onOpenSettings={() => setOverlay("settings")}
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

      {overlay === "agent" && (
        <NewAgent
          initialAgent={agentPick}
          defaultDir={activeSession?.dir ?? "~"}
          onClose={() => setOverlay(null)}
          onCreate={(agent: string, dir: string, prompt: string) => {
            const agentCode = agent as AgentCode;
            setAgentPick(agentCode);
            setOverlay(null);
            const session = createSession("agent", dir, {
              agent: agentCode,
              title: prompt.slice(0, 40) || `${agentCode} 会话`,
              prompt,
            });
            addSession(session);
            preflightAgent(agentCode)
              .then((pf) => {
                if (!pf.installed || !pf.loggedIn) {
                  applyEvent(session.id, { kind: "failed", message: pf.hint ?? `${agentCode} 未安装或未登录` });
                  return;
                }
                spawnAgent(agentCode, prompt, dir, undefined, (ev) => handleAgentEvent(session.id, ev))
                  .then((procId) => updateSession(session.id, { procId }))
                  .catch((err) => applyEvent(session.id, { kind: "failed", message: String(err) }));
              })
              .catch((err) => applyEvent(session.id, { kind: "failed", message: String(err) }));
          }}
        />
      )}

      {overlay === "settings" && <Settings onClose={() => setOverlay(null)} />}
    </div>
  );
}
