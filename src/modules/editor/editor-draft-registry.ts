import type { SshWriteOutcomeUnknown } from "@/modules/ssh/ssh-write-reconcile";

export type EditorDraftSaveState = "idle" | "saving" | "reconciling" | "saved" | "conflict" | "unknown" | "error";

export interface EditorDraftSnapshot {
  content: string;
  savedContent: string;
  fingerprint: string;
  saveState: EditorDraftSaveState;
  unknownOutcome: SshWriteOutcomeUnknown | null;
  unknownAttemptContent: string | null;
  saveAttemptId: string | null;
}

const drafts = new Map<string, EditorDraftSnapshot>();
const completionListeners = new Map<string, Set<(snapshot: EditorDraftSnapshot) => void>>();
const completionBacklog = new Map<string, EditorDraftSnapshot>();

export function editorDraftKey(sessionId: string | null, filePath: string): string {
  return `${sessionId ?? "no-session"}\0${filePath}`;
}

export function readEditorDraft(key: string): EditorDraftSnapshot | null {
  return drafts.get(key) ?? null;
}

export function retainEditorDraft(key: string, snapshot: EditorDraftSnapshot): void {
  if (
    snapshot.content === snapshot.savedContent
    && snapshot.unknownOutcome === null
    && snapshot.saveAttemptId === null
  ) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, snapshot);
}

export type EditorDraftSaveCompletion =
  | { status: "saved"; fingerprint: string }
  | { status: "conflict" }
  | { status: "unknown"; outcome: SshWriteOutcomeUnknown }
  | { status: "retryUnknown" }
  | { status: "error" };

/**
 * Complete only the save or reconciliation attempt that currently owns this
 * draft. This remains authoritative after an editor remount, while an explicit
 * discard prevents a late completion from resurrecting the draft.
 */
export function completeEditorDraftSaveAttempt(
  key: string,
  attemptId: string,
  completion: EditorDraftSaveCompletion,
): EditorDraftSnapshot | null {
  const current = drafts.get(key);
  if (!current || current.saveAttemptId !== attemptId || current.unknownAttemptContent === null) {
    return null;
  }
  const attemptedContent = current.unknownAttemptContent;
  const next: EditorDraftSnapshot = completion.status === "saved"
    ? {
        ...current,
        savedContent: attemptedContent,
        fingerprint: completion.fingerprint,
        saveState: "saved",
        unknownOutcome: null,
        unknownAttemptContent: null,
        saveAttemptId: null,
      }
    : completion.status === "unknown"
      ? {
          ...current,
          saveState: "unknown",
          unknownOutcome: completion.outcome,
          saveAttemptId: null,
        }
      : completion.status === "retryUnknown"
        ? {
            ...current,
            saveState: "unknown",
            saveAttemptId: null,
          }
      : {
          ...current,
          saveState: completion.status === "conflict" ? "conflict" : "error",
          unknownOutcome: null,
          unknownAttemptContent: null,
          saveAttemptId: null,
        };
  retainEditorDraft(key, next);
  const listeners = completionListeners.get(key);
  if (listeners?.size) {
    for (const listener of listeners) listener(next);
  } else {
    completionBacklog.set(key, next);
  }
  return next;
}

export function subscribeEditorDraftCompletions(
  key: string,
  listener: (snapshot: EditorDraftSnapshot) => void,
): () => void {
  const listeners = completionListeners.get(key) ?? new Set();
  listeners.add(listener);
  completionListeners.set(key, listeners);
  const pendingCompletion = completionBacklog.get(key);
  if (pendingCompletion) {
    completionBacklog.delete(key);
    listener(pendingCompletion);
  } else {
    const current = drafts.get(key);
    if (current) listener(current);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) completionListeners.delete(key);
  };
}

export function discardEditorDraft(key: string): void {
  drafts.delete(key);
  completionBacklog.delete(key);
}

/** Test-only reset for the in-memory, never-persisted draft registry. */
export function resetEditorDraftRegistryForTests(): void {
  drafts.clear();
  completionListeners.clear();
  completionBacklog.clear();
}
