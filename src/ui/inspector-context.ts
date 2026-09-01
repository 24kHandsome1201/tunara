import type { InspectorTab } from "@/state/ui";

export interface InspectorAutoSelectInput {
  isRemote: boolean;
  hasUnreviewedChanges: boolean;
  previewOpened: boolean;
  hasActivePreviewSource: boolean;
  hasInProgressTransfer: boolean;
}

export interface InspectorAutoSwitchDecision {
  recommended: InspectorTab;
  /** Apply the recommended view now. */
  apply: boolean;
  /** Recommend a view without leaving the current one. */
  defer: boolean;
}

/**
 * Task-driven Inspector default. Priority is Changes, then an already-opened
 * Preview, then in-progress Transfers, otherwise Files.
 */
export function resolveInspectorAutoView(input: InspectorAutoSelectInput): InspectorTab {
  if (input.hasUnreviewedChanges) return "changes";
  if (input.previewOpened && input.hasActivePreviewSource) return "preview";
  if (input.isRemote && input.hasInProgressTransfer) return "transfers";
  return "files";
}

export function hasUnreviewedGitChanges(session: {
  reviewChangesHint?: boolean;
  changes?: { files: readonly unknown[] };
}): boolean {
  return Boolean(session.reviewChangesHint) && (session.changes?.files.length ?? 0) > 0;
}

export function sessionHasInProgressTransfer(aggregate: {
  queued?: number;
  running?: number;
} | undefined): boolean {
  return ((aggregate?.queued ?? 0) + (aggregate?.running ?? 0)) > 0;
}

/**
 * Auto-switch is restrained: never yank the Inspector away from a file the
 * user is reading. A deferred recommendation can surface as a quiet hint.
 */
export function isViewingInspectorFiles(input: {
  currentTab: InspectorTab;
  hasActiveFileTab: boolean;
}): boolean {
  return input.currentTab === "files" && input.hasActiveFileTab;
}

export function resolveInspectorAutoSwitch(input: {
  locked: boolean;
  current: InspectorTab;
  recommended: InspectorTab;
  viewingFiles: boolean;
}): InspectorAutoSwitchDecision {
  if (input.locked || input.current === input.recommended) {
    return { recommended: input.recommended, apply: false, defer: false };
  }
  if (input.viewingFiles) {
    return { recommended: input.recommended, apply: false, defer: true };
  }
  return { recommended: input.recommended, apply: true, defer: false };
}
