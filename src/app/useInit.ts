import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/state/sessions";
import { loadUserConfig, useUIStore } from "@/state/ui";
import {
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  type WorkspaceProjectionV1,
  type WorkspaceSnapshotV1,
} from "@/state/persist";
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
import {
  diffWatchedDirs,
  gitWatchDirProjection,
  sameGitWatchDirProjection,
} from "./lib/sync-watches";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";
import { requestActiveDirtyDraftAction } from "@/modules/editor/dirty-draft-guard";
import { splitLayoutSessionIds } from "@/modules/session/split-layout";
import { recordFrontendPerf } from "@/modules/perf/benchmark-counters";
import { registerWorkspaceFlush } from "./app-lifecycle";

function buildWorkspaceProjection(): WorkspaceProjectionV1 {
  recordFrontendPerf("workspaceProjections");
  const st = useSessionsStore.getState();
  const ui = useUIStore.getState();
  const agentResume: WorkspaceSnapshotV1["agentResume"] = {};
  for (const s of st.sessions) {
    if (s.agentResume) agentResume[s.id] = s.agentResume;
  }
  return {
    version: 1,
    activeSessionId: st.activeSessionId,
    sessions: st.sessions.map(toPersistedSession),
    ui: {
      sidebarVisible: ui.sidebarVisible,
      panelVisible: ui.panelVisible,
      collapsedDirs: ui.collapsedDirs,
      collapsedDiffSections: ui.collapsedDiffSections,
      split: ui.split,
      inspectorTab: ui.inspectorTab,
      explorerFollowCwd: ui.explorerFollowCwd,
    },
    terminals: getAllTerminalSnapshots(),
    agentResume,
    recentDirs: st.recentDirs,
    recentCommands: st.recentCommands,
    hostFilePrefs: st.hostFilePrefs,
    commandUsage: ui.commandUsage,
  };
}

function buildSnapshot(): WorkspaceSnapshotV1 {
  return { ...buildWorkspaceProjection(), savedAt: Date.now() };
}

export function useInit() {
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    // TerminalView reads several settings only during its first mount. Hold
    // App.ready until both config and workspace hydration finish so a slow
    // config read cannot initialize the first PTY with default-only settings.
    const configReady = loadUserConfig();
    let workspaceHydrated = false;

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
        workspaceHydrated = true;
        useUIStore.setState({ ready: true });
        return;
      }

      if (result.status === "empty") {
        workspaceHydrated = true;
        useUIStore.setState({ ready: true });
        return;
      }

      const snapshot = result.snapshot;

      const restored = snapshot.sessions.map((p) => ({
        ...p,
        title: p.title.trim() || t("session.default_title"),
        customTitle: p.customTitle || undefined,
        pinned: p.pinned || undefined,
        agentResume: snapshot.agentResume[p.id],
        runState: "idle" as const,
      }));

      const merged = current.sessions.length === 0
        ? restored
        : [
            ...restored,
            ...current.sessions.filter((s) => !restored.some((r) => r.id === s.id)),
          ];

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
        workspacePersistenceRevision: current.workspacePersistenceRevision,
        launchedSessionIds,
        recentDirs: snapshot.recentDirs,
        recentCommands: snapshot.recentCommands,
        hostFilePrefs: snapshot.hostFilePrefs ?? {},
      });

      useUIStore.setState({
        sidebarVisible: snapshot.ui.sidebarVisible,
        panelVisible: snapshot.ui.panelVisible,
        collapsedDirs: snapshot.ui.collapsedDirs,
        collapsedDiffSections: snapshot.ui.collapsedDiffSections,
        split: snapshot.ui.split,
        inspectorTab: snapshot.ui.inspectorTab,
        commandUsage: snapshot.commandUsage ?? {},
        explorerFollowCwd: snapshot.ui.explorerFollowCwd !== false,
      });

      if (snapshot.terminals && Object.keys(snapshot.terminals).length > 0) {
        restoreTerminalSnapshots(snapshot.terminals);
      }

      workspaceHydrated = true;
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
    const persistNow = (terminalDirtyAlreadyConsumed = false) => {
      const includedTerminalDirty = terminalDirtyAlreadyConsumed || consumeTerminalSnapshotDirty();
      const snapshot = buildSnapshot();
      const operation = persistQueue.then(() => {
        recordFrontendPerf("persistenceStoreWrites");
        recordFrontendPerf("persistenceIpc");
        return saveWorkspaceSnapshot(snapshot);
      });
      persistQueue = operation;
      return operation.then((result) => {
        if (result !== "saved" && includedTerminalDirty) markTerminalSnapshotDirty();
        if (result !== "saved") notifyPersistenceFailure("save");
        return result;
      });
    };
    const scheduleSave = () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        recordFrontendPerf("persistenceDebounceMerges");
      }
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void persistNow();
      }, 500);
    };
    const unregisterWorkspaceFlush = registerWorkspaceFlush(() => persistNow());

    if (win) {
      registerUnlisten("window close", () =>
        win.onCloseRequested(async (event) => {
          event.preventDefault();
          const finishClose = async () => {
            recordFrontendPerf("closeFlushes");
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
    let watchedDirProjection: readonly string[] = [];
    const syncGitWatches = (nextProjection: readonly string[]) => {
      const { toAcquire, toRelease, next } = diffWatchedDirs(
        watchedDirs,
        nextProjection,
      );
      for (const dir of toAcquire) acquireGitWatch(dir);
      for (const dir of toRelease) releaseGitWatch(dir);
      watchedDirs = next;
    };
    watchedDirProjection = gitWatchDirProjection(useSessionsStore.getState().sessions);
    syncGitWatches(watchedDirProjection);

    const onWindowFocus = () => {
      const activeId = useSessionsStore.getState().activeSessionId;
      if (activeId) useSessionsStore.getState().refreshGit(activeId);
    };
    window.addEventListener("focus", onWindowFocus);

    let previousPersistenceRevision = useSessionsStore.getState().workspacePersistenceRevision;
    const unsubWorkspacePersistence = useSessionsStore.subscribe((state) => {
      if (state.workspacePersistenceRevision !== previousPersistenceRevision) {
        previousPersistenceRevision = state.workspacePersistenceRevision;
        if (workspaceHydrated) scheduleSave();
      }
    });

    const unsubGitWatchProjection = useSessionsStore.subscribe((state) => {
      const nextProjection = gitWatchDirProjection(state.sessions);
      if (sameGitWatchDirProjection(watchedDirProjection, nextProjection)) return;
      watchedDirProjection = nextProjection;
      syncGitWatches(nextProjection);
    });

    const unsubUI = useUIStore.subscribe(
      (s) => [s.collapsedDirs, s.collapsedDiffSections, s.split, s.inspectorTab, s.sidebarVisible, s.panelVisible, s.commandUsage, s.explorerFollowCwd] as const,
      () => {
        if (workspaceHydrated) scheduleSave();
      },
      { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
    );

    // Backstop flush for terminal scrollback, which lives in the snapshot Map
    // rather than a store, so the scheduleSave subscriptions above never see it.
    // Gate on the snapshot dirty flag so an idle or hidden app with no new
    // output performs no redundant serialize + IPC + disk write every 30s.
    const timer = setInterval(() => {
      if (!consumeTerminalSnapshotDirty()) return;
      recordFrontendPerf("terminalBackstopFlushes");
      void persistNow(true);
    }, 30_000);
    return () => {
      unregisterWorkspaceFlush();
      unsubWorkspacePersistence();
      unsubGitWatchProjection();
      unsubUI();
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
  }, []);
}
