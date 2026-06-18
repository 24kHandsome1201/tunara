// Conduit — 三栏静态外壳（M2）
// 替换 terax 原 App，组合 src/ui/ 下各组件
// M3 将接入真实 xterm.js + PTY + Agent

import { useState } from "react";
import { Titlebar } from "@/ui/Titlebar";
import { Sidebar } from "@/ui/Sidebar";
import { TerminalArea } from "@/ui/TerminalArea";
import { DiffPanel } from "@/ui/DiffPanel";
import { NotifCenter } from "@/ui/NotifCenter";
import { NewAgent } from "@/ui/overlays/NewAgent";
import { Settings } from "@/ui/overlays/Settings";
import { MOCK_SESSIONS, MOCK_NOTIFICATIONS } from "@/ui/mockData";
import type { AgentType, OverlayType, ThemeType } from "@/ui/types";

export default function App() {
  // ── UI 状态（对照设计稿 State Management） ──
  const [activeSessionId, setActiveSessionId] = useState<string>(MOCK_SESSIONS[0].id);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [panelVisible, setPanelVisible] = useState(true);
  const [overlay, setOverlay] = useState<OverlayType>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [agentPick, setAgentPick] = useState<AgentType>("CC");
  const [theme, setTheme] = useState<ThemeType>("light");

  // ── 会话数据（M2 静态，M3 换成 Zustand store）──
  const sessions = MOCK_SESSIONS;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  // 未读通知数
  const unreadCount = MOCK_NOTIFICATIONS.length;

  // ── 响应式：<900px 隐右栏、<720px 隐侧栏（通过媒体 class 处理）──
  // M2 以纯 state 控制，M3 可加 ResizeObserver 联动

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "var(--font-ui)",
        background: "var(--c-bg-white)",
      }}
    >
      {/* 全局动画样式（光标闪烁/呼吸/弹层入场） */}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes sheetIn {
          from { opacity: 0; transform: translate(-50%, -52%); }
          to   { opacity: 1; transform: translate(-50%, -50%); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        /* 响应式：<900px 隐右栏、<720px 隐侧栏 */
        @media (max-width: 900px) {
          .conduit-panel { display: none !important; }
        }
        @media (max-width: 720px) {
          .conduit-sidebar { display: none !important; }
        }
      `}</style>

      {/* 标题栏 */}
      <Titlebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        sidebarVisible={sidebarVisible}
        panelVisible={panelVisible}
        notifOpen={notifOpen}
        unreadCount={unreadCount}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        onTogglePanel={() => setPanelVisible((v) => !v)}
        onToggleNotif={() => setNotifOpen((v) => !v)}
        onSelectSession={setActiveSessionId}
        onNewAgent={() => setOverlay("agent")}
      />

      {/* 主体三栏 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {/* 侧边栏（可折叠） */}
        {sidebarVisible && (
          <div className="conduit-sidebar">
            <Sidebar
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelectSession={setActiveSessionId}
              onNewAgent={() => setOverlay("agent")}
              onOpenSettings={() => setOverlay("settings")}
            />
          </div>
        )}

        {/* 终端中栏 */}
        <TerminalArea
          session={activeSession}
          onViewDiff={() => setPanelVisible(true)}
        />

        {/* 审查/diff 面板（可折叠） */}
        {panelVisible && (
          <div className="conduit-panel">
            <DiffPanel session={activeSession} />
          </div>
        )}
      </div>

      {/* 通知中心下拉 */}
      {notifOpen && (
        <NotifCenter
          notifications={MOCK_NOTIFICATIONS}
          onClose={() => setNotifOpen(false)}
        />
      )}

      {/* 弹层：新建 Agent */}
      {overlay === "agent" && (
        <NewAgent
          initialAgent={agentPick}
          onClose={() => setOverlay(null)}
          onCreate={(agent) => {
            setAgentPick(agent);
            setOverlay(null);
          }}
        />
      )}

      {/* 弹层：设置 */}
      {overlay === "settings" && (
        <Settings
          theme={theme}
          onThemeChange={(t) => setTheme(t)}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  );
}
