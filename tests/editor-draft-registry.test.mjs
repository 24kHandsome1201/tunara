import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  discardEditorDraft,
  editorDraftKey,
  readEditorDraft,
  resetEditorDraftRegistryForTests,
  retainEditorDraft,
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
  });

  assert.deepEqual(readEditorDraft(editorDraftKey("session-a", "/tmp/readme.md")), {
    content: "new",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "unknown",
    unknownOutcome,
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
  });
  assert.equal(readEditorDraft(key), null);

  retainEditorDraft(key, {
    content: "new",
    savedContent: "old",
    fingerprint: "c".repeat(64),
    saveState: "conflict",
    unknownOutcome: null,
  });
  discardEditorDraft(key);
  assert.equal(readEditorDraft(key), null);
});

test("draft registry stays out of workspace persistence and the first-screen module graph", async () => {
  const [persist, explorer] = await Promise.all([
    readFile(new URL("../src/state/persist.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ui/FileExplorer.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(persist, /editor-draft-registry|EditorDraftSnapshot/);
  assert.match(explorer, /lazy\(\(\) => import\("\.\/FilePreview"\)/);
  assert.doesNotMatch(explorer, /import \{ FilePreview \} from "\.\/FilePreview"/);
});
