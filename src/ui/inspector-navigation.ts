import type { InspectorTab } from "@/state/ui";

export const INSPECTOR_TAB_IDS: readonly InspectorTab[] = [
  "changes",
  "files",
  "preview",
  "transfers",
  "forwarding",
];

export const PRIMARY_INSPECTOR_TAB_IDS: readonly InspectorTab[] = INSPECTOR_TAB_IDS;

export const SECONDARY_INSPECTOR_TAB_IDS: readonly InspectorTab[] = [];

export type InspectorOverflowSection = "workspace" | "transfer" | "ssh";

export const INSPECTOR_OVERFLOW_SECTION: Partial<Record<InspectorTab, InspectorOverflowSection>> = {
  preview: "workspace",
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
  return { all, primary: all, secondary: [] };
}
