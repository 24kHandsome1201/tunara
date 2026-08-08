import type { InspectorTab } from "@/state/ui";

export const INSPECTOR_TAB_IDS: readonly InspectorTab[] = [
  "overview",
  "changes",
  "files",
  "preview",
  "notes",
  "transfers",
  "metadata",
  "forwarding",
  "diagnostics",
  "knownHosts",
];

export const PRIMARY_INSPECTOR_TAB_IDS: readonly InspectorTab[] = [
  "overview",
  "changes",
  "files",
];

export const SECONDARY_INSPECTOR_TAB_IDS: readonly InspectorTab[] = [
  "preview",
  "notes",
  "transfers",
  "metadata",
  "forwarding",
  "diagnostics",
  "knownHosts",
];

interface InspectorNavigationOptions {
  filesOnly: boolean;
  isRemote: boolean;
  hasBinding: boolean;
}

export interface InspectorNavigationModel {
  all: readonly InspectorTab[];
  primary: readonly InspectorTab[];
  secondary: readonly InspectorTab[];
}

export function resolveInspectorNavigation({
  filesOnly,
  isRemote,
  hasBinding,
}: InspectorNavigationOptions): InspectorNavigationModel {
  if (filesOnly) {
    return { all: ["files"], primary: ["files"], secondary: [] };
  }

  const all = INSPECTOR_TAB_IDS.filter((id) =>
    (id !== "metadata" || hasBinding)
    && (id !== "forwarding" || isRemote)
  );
  const available = new Set(all);

  const primary = PRIMARY_INSPECTOR_TAB_IDS.filter((id) => available.has(id));
  const secondary = SECONDARY_INSPECTOR_TAB_IDS.filter((id) => available.has(id));

  return { all: [...primary, ...secondary], primary, secondary };
}
