import { useEffect, useRef } from "react";
import { useSessionsStore, createSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { loadSessions, saveSessions, loadUILayout, saveUILayout } from "@/state/persist";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startHooksListener } from "@/modules/terminal/lib/hooks-listener";

export function useInit() {
  const addSession = useSessionsStore((s) => s.addSession);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    loadSessions().then(({ sessions: restored, activeSessionId: restoredActive }) => {
      const current = useSessionsStore.getState();
      if (restored.length === 0 && current.sessions.length === 0) {
        addSession(createSession("~", { title: "终端" }));
        return;
      }
      const merged = current.sessions.length === 0
        ? restored
        : [
            ...restored,
            ...current.sessions.filter((s) => !restored.some((r) => r.id === s.id)),
          ];
      const activeSessionId = merged.some((s) => s.id === current.activeSessionId)
        ? current.activeSessionId
        : merged.some((s) => s.id === restoredActive)
        ? restoredActive
        : merged[0]?.id ?? null;
      useSessionsStore.setState({
        sessions: merged,
        activeSessionId,
        launchedSessionIds: activeSessionId
          ? { ...current.launchedSessionIds, [activeSessionId]: true }
          : current.launchedSessionIds,
      });
    });

    loadUILayout().then((layout) => {
      if (!layout) return;
      const ui = useUIStore.getState();
      ui.setSidebarVisible(layout.sidebarVisible);
      ui.setPanelVisible(layout.panelVisible);
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

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const persistSessionsNow = () => {
      const st = useSessionsStore.getState();
      void saveSessions(st.sessions, st.activeSessionId);
    };
    const scheduleSessionsSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        persistSessionsNow();
      }, 500);
    };

    unlistens.push(
      getCurrentWindow()
        .onCloseRequested(async () => {
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          const st = useSessionsStore.getState();
          const ui = useUIStore.getState();
          await saveSessions(st.sessions, st.activeSessionId);
          await saveUILayout({ sidebarVisible: ui.sidebarVisible, panelVisible: ui.panelVisible });
        }),
    );

    unlistens.push(startHooksListener());

    const onWindowFocus = () => {
      const activeId = useSessionsStore.getState().activeSessionId;
      if (activeId) useSessionsStore.getState().refreshGit(activeId);
    };
    window.addEventListener("focus", onWindowFocus);

    let prevSessions = useSessionsStore.getState().sessions;
    const unsub = useSessionsStore.subscribe((state) => {
      if (state.sessions !== prevSessions) {
        prevSessions = state.sessions;
        scheduleSessionsSave();
      }
    });

    const timer = setInterval(persistSessionsNow, 30_000);
    return () => {
      unsub();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        persistSessionsNow();
      }
      clearInterval(timer);
      window.removeEventListener("focus", onWindowFocus);
      unlistens.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [addSession]);
}
