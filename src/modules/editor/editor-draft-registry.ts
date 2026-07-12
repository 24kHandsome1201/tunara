import type { SshWriteOutcomeUnknown } from "@/modules/ssh/ssh-write-reconcile";

export type EditorDraftSaveState = "idle" | "saving" | "reconciling" | "saved" | "conflict" | "unknown" | "error";

export interface EditorDraftSnapshot {
  content: string;
  savedContent: string;
  fingerprint: string;
  saveState: EditorDraftSaveState;
  unknownOutcome: SshWriteOutcomeUnknown | null;
}

const drafts = new Map<string, EditorDraftSnapshot>();

export function editorDraftKey(sessionId: string | null, filePath: string): string {
  return `${sessionId ?? "no-session"}\0${filePath}`;
}

export function readEditorDraft(key: string): EditorDraftSnapshot | null {
  return drafts.get(key) ?? null;
}

export function retainEditorDraft(key: string, snapshot: EditorDraftSnapshot): void {
  if (snapshot.content === snapshot.savedContent && snapshot.unknownOutcome === null) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, snapshot);
}

export function discardEditorDraft(key: string): void {
  drafts.delete(key);
}

/** Test-only reset for the in-memory, never-persisted draft registry. */
export function resetEditorDraftRegistryForTests(): void {
  drafts.clear();
}
