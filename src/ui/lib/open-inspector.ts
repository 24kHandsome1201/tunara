import { useUIStore, type InspectorTab } from "@/state/ui";

export function openInspectorTab(tab: InspectorTab): void {
  const ui = useUIStore.getState();
  ui.setPanelVisible(true);
  ui.setInspectorTab(tab);
}
