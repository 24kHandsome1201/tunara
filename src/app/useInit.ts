import { useEffect, useRef } from "react";
import { useSessionsStore, createSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { loadSessions, saveSessions, loadUILayout, saveUILayout } from "@/state/persist";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function useInit() {
  const addSession = useSessionsStore((s) => s.addSession);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    loadSessions().then(({ sessions: restored, activeSessionId: restoredActive }) => {
      if (restored.length === 0 && useSessionsStore.getState().sessions.length === 0) {
        addSession(createSession("~", { title: "终端" }));
        return;
      }
      const activeSessionId = restored.some((s) => s.id === restoredActive)
        ? restoredActive
        : restored[0]?.id ?? null;
      useSessionsStore.setState({
        sessions: restored,
        activeSessionId,
        launchedSessionIds: activeSessionId ? { [activeSessionId]: true } : {},
      });
    });

    loadUILayout().then((layout) => {
      if (!layout) return;
      const ui = useUIStore.getState();
      if (layout.sidebarVisible !== ui.sidebarVisible) ui.toggleSidebar();
      if (layout.panelVisible !== ui.panelVisible) ui.togglePanel();
    });

    const unlistens: Array<Promise<() => void>> = [];

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
        unlistens.push(win.onResized(check));
      }
    } catch {
      useUIStore.getState().setTrafficLightWidth(96);
    }

    unlistens.push(
      getCurrentWindow()
        .onCloseRequested(async () => {
          const st = useSessionsStore.getState();
          const ui = useUIStore.getState();
          await saveSessions(st.sessions, st.activeSessionId);
          await saveUILayout({ sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible });
        }),
    );

    const onWindowFocus = () => {
      const activeId = useSessionsStore.getState().activeSessionId;
      if (activeId) useSessionsStore.getState().refreshGit(activeId);
    };
    window.addEventListener("focus", onWindowFocus);

    let prevSessions = useSessionsStore.getState().sessions;
    const unsub = useSessionsStore.subscribe((state) => {
      if (state.sessions !== prevSessions) {
        prevSessions = state.sessions;
        void saveSessions(state.sessions, state.activeSessionId);
      }
    });

    const timer = setInterval(() => {
      const st = useSessionsStore.getState();
      void saveSessions(st.sessions, st.activeSessionId);
    }, 30_000);
    return () => {
      unsub();
      clearInterval(timer);
      window.removeEventListener("focus", onWindowFocus);
      unlistens.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [addSession]);
}
