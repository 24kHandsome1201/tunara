import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeEditorDraftSaveAttempt,
  discardEditorDraft,
  editorDraftKey,
  readEditorDraft,
  resetEditorDraftRegistryForTests,
  retainEditorDraft,
  subscribeEditorDraftCompletions,
} from "../src/modules/editor/editor-draft-registry.ts";

test.beforeEach(() => resetEditorDraftRegistryForTests());

test("dirty SSH draft and unknown token survive a transport-handle remount", () => {
  const key = editorDraftKey("session-a", "/tmp/readme.md");
  const unknownOutcome = {
    token: "outcomeUnknown:token",
    attemptedFingerprint: "a".repeat(64),
    expectedMode: 0o640,
    replaceLockOwner: "b".repeat(64),
    cleanupPending: true,
  };
  retainEditorDraft(key, {
    content: "new",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "unknown",
    unknownOutcome,
    unknownAttemptContent: "new",
    saveAttemptId: null,
  });

  assert.deepEqual(readEditorDraft(editorDraftKey("session-a", "/tmp/readme.md")), {
    content: "new",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "unknown",
    unknownOutcome,
    unknownAttemptContent: "new",
    saveAttemptId: null,
  });
  assert.equal(readEditorDraft(editorDraftKey("session-b", "/tmp/readme.md")), null);
});

test("clean drafts are removed and explicit discard clears retained state", () => {
  const key = editorDraftKey("session-a", "/tmp/readme.md");
  retainEditorDraft(key, {
    content: "same",
    savedContent: "same",
    fingerprint: "c".repeat(64),
    saveState: "idle",
    unknownOutcome: null,
    unknownAttemptContent: null,
    saveAttemptId: null,
  });
  assert.equal(readEditorDraft(key), null);

  retainEditorDraft(key, {
    content: "new",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "conflict",
    unknownOutcome: null,
    unknownAttemptContent: null,
    saveAttemptId: null,
  });
  discardEditorDraft(key);
  assert.equal(readEditorDraft(key), null);
});

test("a save completion crosses an editor remount but never resurrects an explicit discard", () => {
  const key = editorDraftKey("session-a", "/tmp/pending.md");
  const unknownOutcome = {
    token: "outcomeUnknown:token",
    attemptedFingerprint: "a".repeat(64),
    expectedMode: 0o640,
    replaceLockOwner: "b".repeat(64),
    cleanupPending: true,
  };
  retainEditorDraft(key, {
    content: "newer draft",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "saving",
    unknownOutcome: null,
    unknownAttemptContent: "attempted",
    saveAttemptId: "attempt-1",
  });
  completeEditorDraftSaveAttempt(key, "attempt-1", { status: "unknown", outcome: unknownOutcome });

  let observed = null;
  const unsubscribe = subscribeEditorDraftCompletions(key, (snapshot) => { observed = snapshot; });
  assert.deepEqual(observed, {
    content: "newer draft",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "unknown",
    unknownOutcome,
    unknownAttemptContent: "attempted",
    saveAttemptId: null,
  });
  unsubscribe();

  discardEditorDraft(key);
  assert.equal(
    completeEditorDraftSaveAttempt(key, "attempt-1", { status: "saved", fingerprint: "d".repeat(64) }),
    null,
  );
  assert.equal(readEditorDraft(key), null);
});

test("draft registry stays out of workspace persistence and the editor remains lazy", async () => {
  const [persist, main] = await Promise.all([
    readFile(new URL("../src/state/persist.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ui/MainArea.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(persist, /editor-draft-registry|EditorDraftSnapshot/);
  assert.match(main, /lazy\(\(\) => import\("\.\/FilePreview"\)/);
  assert.doesNotMatch(main, /import \{ FilePreview \} from "\.\/FilePreview"/);
});
