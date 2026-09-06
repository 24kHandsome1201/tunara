import type { InspectorTab } from "@/state/ui";

export const INSPECTOR_TAB_IDS: readonly InspectorTab[] = [
  "files",
  "changes",
  "preview",
  "transfers",
  "forwarding",
];

const REMOTE_ONLY_INSPECTOR_TAB_IDS = new Set<InspectorTab>([
  "transfers",
  "forwarding",
]);

interface InspectorNavigationOptions {
  filesOnly: boolean;
  isRemote: boolean;
  previewAvailable?: boolean;
  hasInProgressTransfer?: boolean;
  current?: InspectorTab;
}

export interface InspectorNavigationModel {
  all: readonly InspectorTab[];
  primary: readonly InspectorTab[];
  secondary: readonly InspectorTab[];
}

export function resolveInspectorNavigation({
  filesOnly,
  isRemote,
  previewAvailable = false,
  hasInProgressTransfer = false,
  current,
}: InspectorNavigationOptions): InspectorNavigationModel {
  if (filesOnly) {
    return { all: ["files"], primary: ["files"], secondary: [] };
  }

  const all = INSPECTOR_TAB_IDS.filter((id) => !REMOTE_ONLY_INSPECTOR_TAB_IDS.has(id) || isRemote);
  const primary = all.filter((id) => id === "files" || id === "changes" || id === current
    || (id === "preview" && previewAvailable)
    || (id === "transfers" && hasInProgressTransfer));
  return { all, primary, secondary: all.filter((id) => !primary.includes(id)) };
}
