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

const drafts = new Map<symbol, DirtyDraftRegistration>();
let pendingAction: PendingDraftAction | null = null;

export function registerDirtyDraft(registration: DirtyDraftRegistration): () => void {
  drafts.set(registration.owner, registration);
  return () => {
    drafts.delete(registration.owner);
    if (pendingAction?.owner === registration.owner) pendingAction = null;
  };
}

export function updateDirtyDraft(owner: symbol, dirty: boolean): void {
  const draft = drafts.get(owner);
  if (!draft) return;
  drafts.set(owner, { ...draft, dirty });
  if (!dirty && pendingAction?.owner === owner) pendingAction = null;
}

function requestDraftAction(draft: DirtyDraftRegistration | undefined, run: () => void): boolean {
  if (!draft?.dirty) return true;
  pendingAction = { owner: draft.owner, run };
  draft.requestConfirmation();
  return false;
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
  const affected = new Set(affectedSessionIds);
  const draft = [...drafts.values()].find((candidate) =>
    candidate.dirty && affected.has(candidate.sessionId),
  );
  return requestDraftAction(draft, run);
}

export function requestDirtyDraftFileAction(
  sessionId: string,
  filePath: string,
  run: () => void,
): boolean {
  const draft = [...drafts.values()].find((candidate) =>
    candidate.sessionId === sessionId && candidate.filePath === filePath,
  );
  return requestDraftAction(draft, run);
}

/**
 * Guards an application-wide action such as hiding the native window. Unlike
 * session navigation, this always affects the active editor regardless of the
 * session that owns it.
 */
export function requestActiveDirtyDraftAction(run: () => void): boolean {
  const draft = [...drafts.values()].find((candidate) => candidate.dirty);
  return requestDraftAction(draft, () => {
    // An application-wide close affects every mounted file tab. Re-enter the
    // guard after each discard so multiple dirty files are confirmed one by
    // one instead of letting the first confirmation discard the rest.
    if (requestActiveDirtyDraftAction(run)) run();
  });
}

export function confirmDirtyDraftDiscard(owner: symbol): boolean {
  const draft = drafts.get(owner);
  if (!draft || pendingAction?.owner !== owner) return false;
  const action = pendingAction;
  pendingAction = null;
  drafts.set(owner, { ...draft, dirty: false });
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
  drafts.clear();
  pendingAction = null;
}
