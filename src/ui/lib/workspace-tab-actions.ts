import { requestDirtyDraftFileAction } from "@/modules/editor/dirty-draft-guard";
import {
  cycleTitlebarItems,
  filesOnSameDevice,
  focusTitlebarDeviceSessionId,
  titlebarWorkingSet,
  titlebarWorkingSetVisible,
  visibleTitlebarItems,
  type TitlebarWorkingSet,
} from "@/modules/session/titlebar-working-set";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore, type WorkspaceFileTab } from "@/state/ui";

function currentWorkingSet(): TitlebarWorkingSet {
  const ui = useUIStore.getState();
  return titlebarWorkingSet({
    sessions: useSessionsStore.getState().sessions,
    fileTabs: ui.fileTabs,
    activeSessionId: useSessionsStore.getState().activeSessionId,
    sidebarVisible: ui.sidebarVisible,
  });
}

/** File surface is on-screen. Pure Mode keeps the selected file but hides it. */
export function isFileSurfaceActive(): boolean {
  const ui = useUIStore.getState();
  return ui.presentationMode === "workspace" && ui.activeFileTabId !== null;
}

export function activateWorkspaceFileTab(tab: WorkspaceFileTab): void {
  useSessionsStore.getState().setActive(tab.sessionId);
  useUIStore.getState().setActiveFileTab(tab.id);
}

export function requestCloseWorkspaceFileTab(tab: WorkspaceFileTab): void {
  const close = () => {
    const sessions = useSessionsStore.getState().sessions;
    const ui = useUIStore.getState();
    const wasActive = ui.activeFileTabId === tab.id;
    const siblings = filesOnSameDevice(tab, ui.fileTabs, sessions);
    const index = siblings.findIndex((candidate) => candidate.id === tab.id);
    const remaining = siblings.filter((candidate) => candidate.id !== tab.id);
    const adjacent = remaining[Math.min(index, remaining.length - 1)] ?? remaining[remaining.length - 1];
    useUIStore.getState().closeFileTab(tab.id);
    if (!wasActive) return;
    if (adjacent) {
      const next = useUIStore.getState().fileTabs.find((candidate) => candidate.id === adjacent.id);
      if (next) activateWorkspaceFileTab(next);
      return;
    }
    useSessionsStore.getState().setActive(tab.sessionId);
  };
  if (requestDirtyDraftFileAction(tab.sessionId, tab.filePath, close)) close();
}

/** Close the active file tab. Returns false when the file surface is not showing. */
export function handleFileSurfaceClose(): boolean {
  if (!isFileSurfaceActive()) return false;
  const ui = useUIStore.getState();
  const tab = ui.fileTabs.find((candidate) => candidate.id === ui.activeFileTabId);
  if (!tab) return false;
  requestCloseWorkspaceFileTab(tab);
  return true;
}

function selectWorkingSetItem(index: number, fromEnd: boolean): boolean {
  const workingSet = currentWorkingSet();
  if (!titlebarWorkingSetVisible(workingSet)) return false;
  const items = visibleTitlebarItems(workingSet);
  const item = fromEnd ? items[items.length - 1] : items[index];
  if (!item) return true;
  if (item.kind === "terminal") {
    useSessionsStore.getState().setActive(item.id);
    return true;
  }
  if (!item.tab) return true;
  const tab = useUIStore.getState().fileTabs.find((candidate) => candidate.id === item.tab?.id);
  if (tab) activateWorkspaceFileTab(tab);
  return true;
}

/** Select the Nth visible titlebar tab (0-based). No-op if that slot does not exist. */
export function handleFileSurfaceSelectIndex(index: number): boolean {
  return selectWorkingSetItem(index, false);
}

export function handleFileSurfaceSelectLast(): boolean {
  return selectWorkingSetItem(0, true);
}

/**
 * Walk the current device's terminals then files so Mod+Tab can leave a file
 * back to a terminal without closing the tab, including while the sidebar hides
 * those terminal tabs.
 */
export function handleFileSurfaceCycle(direction: "next" | "prev"): boolean {
  if (!isFileSurfaceActive()) return false;
  const ui = useUIStore.getState();
  const ordered = cycleTitlebarItems(currentWorkingSet());
  if (ordered.length < 2) return true;
  const idx = ordered.findIndex((item) => item.kind === "file" && item.id === ui.activeFileTabId);
  if (idx < 0) return true;
  const step = direction === "next" ? 1 : -1;
  const next = ordered[(idx + step + ordered.length) % ordered.length];
  if (next.kind === "terminal") {
    useSessionsStore.getState().setActive(next.id);
    return true;
  }
  const tab = ui.fileTabs.find((candidate) => candidate.id === next.id);
  if (tab) activateWorkspaceFileTab(tab);
  return true;
}

export function focusTitlebarDevice(deviceKey: string): void {
  const sessions = useSessionsStore.getState().sessions;
  const activeSessionId = useSessionsStore.getState().activeSessionId;
  const current = sessions.find((session) => session.id === activeSessionId);
  if (current && titlebarWorkingSet({
    sessions,
    fileTabs: useUIStore.getState().fileTabs,
    activeSessionId,
    sidebarVisible: useUIStore.getState().sidebarVisible,
  }).deviceKey === deviceKey) return;
  const sessionId = focusTitlebarDeviceSessionId(deviceKey, sessions, activeSessionId);
  if (sessionId) useSessionsStore.getState().setActive(sessionId);
}
