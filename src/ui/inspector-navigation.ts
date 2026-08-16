import type { InspectorTab } from "@/state/ui";

export const INSPECTOR_TAB_IDS: readonly InspectorTab[] = [
  "overview",
  "changes",
  "files",
  "preview",
  "notes",
  "transfers",
  "forwarding",
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
  "forwarding",
];

export type InspectorOverflowSection = "workspace" | "transfer" | "ssh";

export const INSPECTOR_OVERFLOW_SECTION: Partial<Record<InspectorTab, InspectorOverflowSection>> = {
  preview: "workspace",
  notes: "workspace",
  transfers: "transfer",
  forwarding: "ssh",
};

const REMOTE_ONLY_INSPECTOR_TAB_IDS = new Set<InspectorTab>([
  "transfers",
  "forwarding",
]);

interface InspectorNavigationOptions {
  filesOnly: boolean;
  isRemote: boolean;
}

export interface InspectorNavigationModel {
  all: readonly InspectorTab[];
  primary: readonly InspectorTab[];
  secondary: readonly InspectorTab[];
}

export function resolveInspectorNavigation({
  filesOnly,
  isRemote,
}: InspectorNavigationOptions): InspectorNavigationModel {
  if (filesOnly) {
    return { all: ["files"], primary: ["files"], secondary: [] };
  }

  const all = INSPECTOR_TAB_IDS.filter((id) => !REMOTE_ONLY_INSPECTOR_TAB_IDS.has(id) || isRemote);
  const available = new Set(all);

  const primary = PRIMARY_INSPECTOR_TAB_IDS.filter((id) => available.has(id));
  const secondary = SECONDARY_INSPECTOR_TAB_IDS.filter((id) => available.has(id));

  return { all: [...primary, ...secondary], primary, secondary };
}
