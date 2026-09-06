import { useUIStore, type InspectorTab } from "@/state/ui";

/** User-initiated navigation; background activity never replaces this choice. */
export function openInspectorTab(tab: InspectorTab, sessionId?: string): void {
  const ui = useUIStore.getState();
  ui.setPanelVisible(true);
  ui.setInspectorTab(tab, { sessionId: sessionId ?? null });
}
