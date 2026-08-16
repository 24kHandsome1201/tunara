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

export type InspectorOverflowSection = "workspace" | "transfer" | "ssh";

export const INSPECTOR_OVERFLOW_SECTION: Partial<Record<InspectorTab, InspectorOverflowSection>> = {
  preview: "workspace",
  notes: "workspace",
  transfers: "transfer",
  metadata: "ssh",
  forwarding: "ssh",
  diagnostics: "ssh",
  knownHosts: "ssh",
};

const REMOTE_ONLY_INSPECTOR_TAB_IDS = new Set<InspectorTab>([
  "transfers",
  "metadata",
  "forwarding",
  "diagnostics",
  "knownHosts",
]);

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
    (!REMOTE_ONLY_INSPECTOR_TAB_IDS.has(id) || isRemote)
    && (id !== "metadata" || hasBinding)
  );
  const available = new Set(all);

  const primary = PRIMARY_INSPECTOR_TAB_IDS.filter((id) => available.has(id));
  const secondary = SECONDARY_INSPECTOR_TAB_IDS.filter((id) => available.has(id));

  return { all: [...primary, ...secondary], primary, secondary };
}
