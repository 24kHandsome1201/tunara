import { useEffect, useRef } from "react";
import { useSessionsStore, createSession } from "@/state/sessions";
import type { Session } from "@/ui/types";
import { loadUserConfig, useUIStore } from "@/state/ui";
import { loadWorkspaceSnapshot, saveWorkspaceSnapshot, type WorkspaceSnapshotV1 } from "@/state/persist";
import { useWorkflowsStore } from "@/state/workflows";
import { t } from "@/modules/i18n/core.ts";
import {
  consumeTerminalSnapshotDirty,
  getAllTerminalSnapshots,
  markTerminalSnapshotDirty,
  restoreTerminalSnapshots,
} from "@/modules/terminal/lib/terminal-snapshot";
import { platform } from "@tauri-apps/plugin-os";
import { startHooksListener } from "@/modules/terminal/lib/hooks-listener";
import { acquireGitWatch, releaseGitWatch, startGitWatcherListener } from "@/modules/git/git-watcher";
import { toPersistedSession } from "@/state/persist-snapshot";
import { diffWatchedDirs, gitWatchDirsForSessions } from "./lib/sync-watches";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";
import { requestActiveDirtyDraftAction } from "@/modules/editor/dirty-draft-guard";
import { splitLayoutSessionIds } from "@/modules/session/split-layout";

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
    sessions: st.sessions.map(toPersistedSession),
    ui: {
      sidebarVisible: ui.sidebarVisible,
      panelVisible: ui.panelVisible,
      collapsedDirs: ui.collapsedDirs,
      collapsedDiffSections: ui.collapsedDiffSections,
      split: ui.split,
      inspectorTab: ui.inspectorTab,
    },
    terminals: getAllTerminalSnapshots(),
    agentResume,
    recentDirs: st.recentDirs,
    recentCommands: st.recentCommands,
    commandUsage: ui.commandUsage,
    workflows: useWorkflowsStore.getState().workflows,
  };
}

export function useInit() {
  const addSession = useSessionsStore((s) => s.addSession);

  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    // TerminalView reads several settings only during its first mount. Hold
    // App.ready until both config and workspace hydration finish so a slow
    // config read cannot initialize the first PTY with default-only settings.
    const configReady = loadUserConfig();

    const notifiedPersistenceFailures = new Set<"restore" | "save">();
    const notifyPersistenceFailure = (kind: "restore" | "save", detail?: string) => {
      if (notifiedPersistenceFailures.has(kind)) return;
      notifiedPersistenceFailures.add(kind);
      if (detail) console.error(`[useInit] workspace ${kind} failed`, detail);
      useUIStore.getState().addToast({
        title: t(`workspace.${kind}_error.title`),
        subtitle: t(`workspace.${kind}_error.subtitle`),
        variant: "error",
      });
    };

    void Promise.all([configReady, loadWorkspaceSnapshot()]).then(([, result]) => {
      const current = useSessionsStore.getState();

      if (result.status === "error") {
        notifyPersistenceFailure("restore", result.error);
        if (current.sessions.length === 0) {
          addSession(createSession("~", { title: t("session.default_title") }));
        }
        useUIStore.setState({ ready: true });
        return;
      }

      if (result.status === "empty") {
        if (current.sessions.length === 0) {
          addSession(createSession("~", { title: t("session.default_title") }));
        }
        useUIStore.setState({ ready: true });
        return;
      }

      const snapshot = result.snapshot;

      const restored = snapshot.sessions.map((p) => ({
        ...p,
        title: p.title.trim() || t("session.default_title"),
        customTitle: p.customTitle || undefined,
        pinned: p.pinned || undefined,
        note: p.note || undefined,
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
        addSession(createSession("~", { title: t("session.default_title") }));
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
      for (const sessionId of splitLayoutSessionIds(split)) {
        if (merged.some((s) => s.id === sessionId)) launchedSessionIds[sessionId] = true;
      }

      useSessionsStore.setState({
        sessions: merged,
        activeSessionId,
        launchedSessionIds,
        recentDirs: snapshot.recentDirs,
        recentCommands: snapshot.recentCommands,
      });

      useUIStore.setState({
        sidebarVisible: snapshot.ui.sidebarVisible,
        panelVisible: snapshot.ui.panelVisible,
        collapsedDirs: snapshot.ui.collapsedDirs,
        collapsedDiffSections: snapshot.ui.collapsedDiffSections,
        split: snapshot.ui.split,
        inspectorTab: snapshot.ui.inspectorTab,
        commandUsage: snapshot.commandUsage ?? {},
      });

      if (snapshot.workflows?.length) {
        useWorkflowsStore.getState().setWorkflows(snapshot.workflows);
      }

      if (snapshot.terminals && Object.keys(snapshot.terminals).length > 0) {
        restoreTerminalSnapshots(snapshot.terminals);
      }

      useUIStore.setState({ ready: true });
    });

    const unlistens: Array<Promise<() => void>> = [];
    const registerUnlisten = (label: string, start: () => Promise<() => void>) => {
      unlistens.push(
        start().catch((e) => {
          console.warn(`[useInit] ${label} listener unavailable`, e);
          return () => {};
        }),
      );
    };

    const win = tryGetCurrentWindow();

    try {
      if (!win) throw new Error("current window unavailable");
      const p = platform();
      const isMac = p === "macos";
      const syncWindowChrome = (fullscreen: boolean) => {
        const ui = useUIStore.getState();
        ui.setNativeFullscreen(fullscreen);
        ui.setTrafficLightWidth(isMac && !fullscreen ? 96 : 0);
      };

      let pending = false;
      let queued = false;
      const check = () => {
        if (pending) {
          queued = true;
          return;
        }
        pending = true;
        requestAnimationFrame(() => {
          void win.isFullscreen().then(syncWindowChrome).finally(() => {
            pending = false;
            if (queued) {
              queued = false;
              check();
            }
          });
        });
      };
      unlistens.push(win.onResized(check));
      unlistens.push(win.onFocusChanged(check));
      check();
    } catch (e) {
      console.warn("[useInit] platform/window probe failed, assuming macOS traffic lights", e);
      useUIStore.getState().setTrafficLightWidth(96);
    }

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    // Serialize writes so a slower debounced save cannot finish after the
    // close-time flush and overwrite its newer snapshot.
    let persistQueue = Promise.resolve<"saved" | "blocked" | "error">("saved");
    const persistNow = () => {
      const snapshot = buildSnapshot();
      const operation = persistQueue.then(() => saveWorkspaceSnapshot(snapshot));
      persistQueue = operation;
      return operation.then((result) => {
        if (result !== "saved") notifyPersistenceFailure("save");
        return result;
      });
    };
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void persistNow();
      }, 500);
    };

    if (win) {
      registerUnlisten("window close", () =>
        win.onCloseRequested(async (event) => {
          event.preventDefault();
          const finishClose = async () => {
            if (saveTimer) {
              clearTimeout(saveTimer);
              saveTimer = null;
            }
            const result = await persistNow();
            // A corrupt/unreadable store blocks writes to preserve the original,
            // but hiding is safe because the process and in-memory state stay
            // alive. A transient write error keeps the window visible.
            if (result === "error") return;
            await win.hide();
          };
          if (!requestActiveDirtyDraftAction(() => { void finishClose(); })) return;
          await finishClose();
        }),
      );
    }

    registerUnlisten("agent hook", startHooksListener);
    registerUnlisten("git watcher", startGitWatcherListener);

    let watchedDirs: ReadonlySet<string> = new Set<string>();
    const syncGitWatches = (sessions: readonly Session[]) => {
      const { toAcquire, toRelease, next } = diffWatchedDirs(
        watchedDirs,
        // Keep the watch list local-only. Remote sessions use pseudo dirs like
        // user@host, which cannot be watched by the local Git watcher.
        gitWatchDirsForSessions(sessions),
      );
      for (const dir of toAcquire) acquireGitWatch(dir);
      for (const dir of toRelease) releaseGitWatch(dir);
      watchedDirs = next;
    };
    syncGitWatches(useSessionsStore.getState().sessions);

    const onWindowFocus = () => {
      const activeId = useSessionsStore.getState().activeSessionId;
      if (activeId) useSessionsStore.getState().refreshGit(activeId);
    };
    window.addEventListener("focus", onWindowFocus);

    let prevSessions = useSessionsStore.getState().sessions;
    const unsubSessions = useSessionsStore.subscribe((state) => {
      if (state.sessions !== prevSessions) {
        prevSessions = state.sessions;
        syncGitWatches(state.sessions);
        scheduleSave();
      }
    });

    const unsubUI = useUIStore.subscribe(
      (s) => [s.collapsedDirs, s.collapsedDiffSections, s.split, s.inspectorTab, s.sidebarVisible, s.panelVisible, s.commandUsage] as const,
      () => scheduleSave(),
      { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
    );

    let prevWorkflows = useWorkflowsStore.getState().workflows;
    const unsubWorkflows = useWorkflowsStore.subscribe((state) => {
      if (state.workflows !== prevWorkflows) {
        prevWorkflows = state.workflows;
        scheduleSave();
      }
    });

    // Backstop flush for terminal scrollback, which lives in the snapshot Map
    // rather than a store, so the scheduleSave subscriptions above never see it.
    // Gate on the snapshot dirty flag so an idle or hidden app with no new
    // output performs no redundant serialize + IPC + disk write every 30s.
    const timer = setInterval(() => {
      if (!consumeTerminalSnapshotDirty()) return;
      void persistNow().then((result) => {
        if (result !== "saved") markTerminalSnapshotDirty();
      });
    }, 30_000);
    return () => {
      unsubSessions();
      unsubUI();
      unsubWorkflows();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void persistNow();
      }
      clearInterval(timer);
      window.removeEventListener("focus", onWindowFocus);
      for (const dir of watchedDirs) releaseGitWatch(dir);
      unlistens.forEach((p) => p.then((fn) => fn()).catch((e) => console.warn("[useInit] cleanup listener failed", e)));
    };
  }, [addSession]);
}
