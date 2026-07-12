export interface DirtyDraftRegistration {
  owner: symbol;
  sessionId: string;
  filePath: string;
  dirty: boolean;
  requestConfirmation: () => void;
}

interface PendingDraftAction {
  owner: symbol;
  run: () => void;
}

let activeDraft: DirtyDraftRegistration | null = null;
let pendingAction: PendingDraftAction | null = null;

export function registerDirtyDraft(registration: DirtyDraftRegistration): () => void {
  activeDraft = registration;
  return () => {
    if (activeDraft?.owner === registration.owner) activeDraft = null;
    if (pendingAction?.owner === registration.owner) pendingAction = null;
  };
}

export function updateDirtyDraft(owner: symbol, dirty: boolean): void {
  if (activeDraft?.owner !== owner) return;
  activeDraft = { ...activeDraft, dirty };
  if (!dirty && pendingAction?.owner === owner) pendingAction = null;
}

/**
 * Runs an action unless it would navigate away from the session that owns the
 * active dirty editor. A blocked action is retained until the editor's own
 * discard confirmation resolves it, keeping confirmation UI beside the draft.
 */
export function requestDirtyDraftAction(
  affectedSessionIds: readonly string[],
  run: () => void,
): boolean {
  const draft = activeDraft;
  if (!draft?.dirty || !affectedSessionIds.includes(draft.sessionId)) {
    return true;
  }

  pendingAction = { owner: draft.owner, run };
  draft.requestConfirmation();
  return false;
}

export function confirmDirtyDraftDiscard(owner: symbol): boolean {
  if (activeDraft?.owner !== owner || pendingAction?.owner !== owner) return false;
  const action = pendingAction;
  pendingAction = null;
  activeDraft = { ...activeDraft, dirty: false };
  action.run();
  return true;
}

export function cancelDirtyDraftAction(owner: symbol): boolean {
  if (pendingAction?.owner !== owner) return false;
  pendingAction = null;
  return true;
}

export function hasPendingDirtyDraftAction(owner: symbol): boolean {
  return pendingAction?.owner === owner;
}

/** Test-only reset for the module-level UI registry. */
export function resetDirtyDraftGuardForTests(): void {
  activeDraft = null;
  pendingAction = null;
}
