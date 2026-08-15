import { requestDirtyDraftFileAction } from "@/modules/editor/dirty-draft-guard";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore, type WorkspaceFileTab } from "@/state/ui";

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
    const wasActive = useUIStore.getState().activeFileTabId === tab.id;
    useUIStore.getState().closeFileTab(tab.id);
    if (!wasActive) return;
    const ui = useUIStore.getState();
    const adjacent = ui.fileTabs.find((candidate) => candidate.id === ui.activeFileTabId);
    if (!adjacent) return;
    activateWorkspaceFileTab(adjacent);
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

/** Select the Nth file tab (0-based). No-op if that slot does not exist. */
export function handleFileSurfaceSelectIndex(index: number): boolean {
  if (!isFileSurfaceActive()) return false;
  const tab = useUIStore.getState().fileTabs[index];
  if (!tab) return true;
  activateWorkspaceFileTab(tab);
  return true;
}

export function handleFileSurfaceSelectLast(): boolean {
  if (!isFileSurfaceActive()) return false;
  const tabs = useUIStore.getState().fileTabs;
  const tab = tabs[tabs.length - 1];
  if (!tab) return true;
  activateWorkspaceFileTab(tab);
  return true;
}

/**
 * Walk the titlebar order (sessions then files) so Mod+Tab can leave a file
 * back to a terminal without closing the tab.
 */
export function handleFileSurfaceCycle(direction: "next" | "prev"): boolean {
  if (!isFileSurfaceActive()) return false;
  const ui = useUIStore.getState();
  const sessions = useSessionsStore.getState().sessions;
  const ordered: Array<{ kind: "terminal"; id: string } | { kind: "file"; tab: WorkspaceFileTab }> = [
    ...sessions.map((session) => ({ kind: "terminal" as const, id: session.id })),
    ...ui.fileTabs.map((tab) => ({ kind: "file" as const, tab })),
  ];
  if (ordered.length < 2) return true;
  const idx = ordered.findIndex((item) => item.kind === "file" && item.tab.id === ui.activeFileTabId);
  if (idx < 0) return true;
  const step = direction === "next" ? 1 : -1;
  const next = ordered[(idx + step + ordered.length) % ordered.length];
  if (next.kind === "terminal") {
    useSessionsStore.getState().setActive(next.id);
    return true;
  }
  activateWorkspaceFileTab(next.tab);
  return true;
}
