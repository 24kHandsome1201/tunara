import { useEffect, useRef } from "react";
import { useSessionsStore, createSession } from "@/state/sessions";
import { loadUserConfig, useUIStore } from "@/state/ui";
import { loadWorkspaceSnapshot, saveWorkspaceSnapshot, type WorkspaceSnapshotV1 } from "@/state/persist";
import { getAllTerminalSnapshots, restoreTerminalSnapshots } from "@/modules/terminal/lib/terminal-snapshot";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startHooksListener } from "@/modules/terminal/lib/hooks-listener";

function buildSnapshot(): WorkspaceSnapshotV1 {
  const st = useSessionsStore.getState();
  const ui = useUIStore.getState();
  const agentResume: WorkspaceSnapshotV1["agentResume"] = {};
  for (const s of st.sessions) {
    if (s.agentResume) agentResume[s.id] = s.agentResume;
  }
  return {
    version: 1,
    savedAt: Date.now(),
    activeSessionId: st.activeSessionId,
    sessions: st.sessions.map((s) => {
      const p: WorkspaceSnapshotV1["sessions"][number] = {
        id: s.id,
        title: s.title,
        dir: s.dir,
        branch: s.branch,
        updatedAt: s.updatedAt,
      };
      if (s.customTitle) p.customTitle = s.customTitle;
      return p;
    }),
    ui: {
      sidebarVisible: ui.sidebarVisible,
      panelVisible: ui.panelVisible,
      collapsedDirs: ui.collapsedDirs,
      split: ui.split,
      inspectorTab: ui.inspectorTab,
    },
    terminals: getAllTerminalSnapshots(),
    agentResume,
  };
}

export function useInit() {
  const addSession = useSessionsStore((s) => s.addSession);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    void loadUserConfig();

    loadWorkspaceSnapshot().then((snapshot) => {
      const current = useSessionsStore.getState();

      if (!snapshot) {
        if (current.sessions.length === 0) {
          addSession(createSession("~", { title: "终端" }));
        }
        useUIStore.setState({ ready: true });
        return;
      }

      const restored = snapshot.sessions.map((p) => ({
        ...p,
        title: p.title.trim() || "终端",
        customTitle: p.customTitle || undefined,
        agentResume: snapshot.agentResume[p.id],
        runState: "idle" as const,
      }));

      const merged = current.sessions.length === 0
        ? restored
        : [
            ...restored,
            ...current.sessions.filter((s) => !restored.some((r) => r.id === s.id)),
          ];

      if (merged.length === 0) {
        addSession(createSession("~", { title: "终端" }));
        useUIStore.setState({ ready: true });
        return;
      }

      const restoredActive = snapshot.activeSessionId;
      const activeSessionId = merged.some((s) => s.id === current.activeSessionId)
        ? current.activeSessionId
        : merged.some((s) => s.id === restoredActive)
        ? restoredActive
        : merged[0]?.id ?? null;

      const launchedSessionIds: Record<string, true> = { ...current.launchedSessionIds };
      if (activeSessionId) launchedSessionIds[activeSessionId] = true;

      const { split } = snapshot.ui;
      if (split.mode !== "single") {
        if (split.paneA && merged.some((s) => s.id === split.paneA)) {
          launchedSessionIds[split.paneA] = true;
        }
        if (split.paneB && merged.some((s) => s.id === split.paneB)) {
          launchedSessionIds[split.paneB] = true;
        }
      }

      useSessionsStore.setState({ sessions: merged, activeSessionId, launchedSessionIds });

      useUIStore.setState({
        sidebarVisible: snapshot.ui.sidebarVisible,
        panelVisible: snapshot.ui.panelVisible,
        collapsedDirs: snapshot.ui.collapsedDirs,
        split: snapshot.ui.split,
        inspectorTab: snapshot.ui.inspectorTab,
      });

      if (snapshot.terminals && Object.keys(snapshot.terminals).length > 0) {
        restoreTerminalSnapshots(snapshot.terminals);
      }

      useUIStore.setState({ ready: true });
    });

    const unlistens: Array<Promise<() => void>> = [];
    const win = getCurrentWindow();

    try {
      const p = platform();
      const isMac = p === "macos";
      const setTL = (fs: boolean) =>
        useUIStore.getState().setTrafficLightWidth(isMac && !fs ? 96 : 0);

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
    const persistNow = () => {
      void saveWorkspaceSnapshot(buildSnapshot());
    };
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        persistNow();
      }, 500);
    };

    unlistens.push(
      win.onCloseRequested(async () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        await saveWorkspaceSnapshot(buildSnapshot());
      }),
    );

    unlistens.push(startHooksListener());

    const onWindowFocus = () => {
      const activeId = useSessionsStore.getState().activeSessionId;
      if (activeId) useSessionsStore.getState().refreshGit(activeId);
    };
    window.addEventListener("focus", onWindowFocus);

    let prevSessions = useSessionsStore.getState().sessions;
    const unsubSessions = useSessionsStore.subscribe((state) => {
      if (state.sessions !== prevSessions) {
        prevSessions = state.sessions;
        scheduleSave();
      }
    });

    const unsubUI = useUIStore.subscribe(
      (s) => [s.collapsedDirs, s.split, s.inspectorTab, s.sidebarVisible, s.panelVisible] as const,
      () => scheduleSave(),
      { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
    );

    const timer = setInterval(persistNow, 30_000);
    return () => {
      unsubSessions();
      unsubUI();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        persistNow();
      }
      clearInterval(timer);
      window.removeEventListener("focus", onWindowFocus);
      unlistens.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [addSession]);
}
