import { useUIStore, type InspectorTab } from "@/state/ui";

/** User-initiated Inspector navigation: opens the rail and locks the view. */
export function openInspectorTab(tab: InspectorTab, sessionId?: string): void {
  const ui = useUIStore.getState();
  ui.setPanelVisible(true);
  ui.setInspectorTab(tab, { sessionId: sessionId ?? null });
  if (tab === "preview" && sessionId) ui.markInspectorPreviewOpened(sessionId);
}
