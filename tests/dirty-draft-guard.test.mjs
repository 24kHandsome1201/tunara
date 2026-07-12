import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  cancelDirtyDraftAction,
  confirmDirtyDraftDiscard,
  registerDirtyDraft,
  requestActiveDirtyDraftAction,
  requestDirtyDraftAction,
  resetDirtyDraftGuardForTests,
  updateDirtyDraft,
} from "../src/modules/editor/dirty-draft-guard.ts";

test.beforeEach(() => resetDirtyDraftGuardForTests());

test("unrelated session actions are allowed without taking ownership of execution", () => {
  const owner = Symbol("draft");
  let confirmations = 0;
  let runs = 0;
  registerDirtyDraft({ owner, sessionId: "a", filePath: "/a.txt", dirty: true, requestConfirmation: () => confirmations++ });

  assert.equal(requestDirtyDraftAction(["b"], () => runs++), true);
  assert.equal(runs, 0);
  assert.equal(confirmations, 0);
});

test("dirty owning-session action waits for explicit discard", () => {
  const owner = Symbol("draft");
  let confirmations = 0;
  let runs = 0;
  registerDirtyDraft({ owner, sessionId: "a", filePath: "/a.txt", dirty: true, requestConfirmation: () => confirmations++ });

  assert.equal(requestDirtyDraftAction(["a"], () => runs++), false);
  assert.equal(runs, 0);
  assert.equal(confirmations, 1);
  assert.equal(confirmDirtyDraftDiscard(owner), true);
  assert.equal(runs, 1);
  assert.equal(confirmDirtyDraftDiscard(owner), false);
  assert.equal(runs, 1);
});

test("application-wide close waits for explicit discard", () => {
  const owner = Symbol("draft");
  let confirmations = 0;
  let closes = 0;
  registerDirtyDraft({ owner, sessionId: "a", filePath: "/a.txt", dirty: true, requestConfirmation: () => confirmations++ });

  assert.equal(requestActiveDirtyDraftAction(() => closes++), false);
  assert.equal(confirmations, 1);
  assert.equal(closes, 0);
  assert.equal(confirmDirtyDraftDiscard(owner), true);
  assert.equal(closes, 1);
});

test("application-wide close allows a clean editor without retaining an action", () => {
  const owner = Symbol("draft");
  registerDirtyDraft({ owner, sessionId: "a", filePath: "/a.txt", dirty: false, requestConfirmation: () => {} });
  assert.equal(requestActiveDirtyDraftAction(() => {}), true);
  assert.equal(confirmDirtyDraftDiscard(owner), false);
});

test("cancel keeps the dirty draft and drops pending navigation", () => {
  const owner = Symbol("draft");
  let runs = 0;
  registerDirtyDraft({ owner, sessionId: "a", filePath: "/a.txt", dirty: true, requestConfirmation: () => {} });

  assert.equal(requestDirtyDraftAction(["a"], () => runs++), false);
  assert.equal(cancelDirtyDraftAction(owner), true);
  assert.equal(confirmDirtyDraftDiscard(owner), false);
  assert.equal(runs, 0);
  assert.equal(requestDirtyDraftAction(["a"], () => runs++), false);
});

test("saving clears the guard and stale owners cannot resolve a new draft", () => {
  const first = Symbol("first");
  const second = Symbol("second");
  let runs = 0;
  registerDirtyDraft({ owner: first, sessionId: "a", filePath: "/a.txt", dirty: true, requestConfirmation: () => {} });
  assert.equal(requestDirtyDraftAction(["a"], () => runs++), false);
  updateDirtyDraft(first, false);
  assert.equal(confirmDirtyDraftDiscard(first), false);

  registerDirtyDraft({ owner: second, sessionId: "b", filePath: "/b.txt", dirty: true, requestConfirmation: () => {} });
  assert.equal(requestDirtyDraftAction(["b"], () => runs++), false);
  assert.equal(confirmDirtyDraftDiscard(first), false);
  assert.equal(confirmDirtyDraftDiscard(second), true);
  assert.equal(runs, 1);
});

test("latest blocked intent replaces an older navigation intent", () => {
  const owner = Symbol("draft");
  const runs = [];
  registerDirtyDraft({ owner, sessionId: "a", filePath: "/a.txt", dirty: true, requestConfirmation: () => {} });

  requestDirtyDraftAction(["a"], () => runs.push("first"));
  requestDirtyDraftAction(["a"], () => runs.push("second"));
  confirmDirtyDraftDiscard(owner);
  assert.deepEqual(runs, ["second"]);
});

test("session navigation and removal boundaries are wired to the central guard", async () => {
  const source = await readFile(new URL("../src/state/sessions.ts", import.meta.url), "utf8");
  assert.match(source, /setActive: \(id\) => \{[\s\S]*requestDirtyDraftAction\(\[currentId\]/);
  assert.match(source, /removeSession: \(id\) => \{\s*if \(!requestDirtyDraftAction\(\[id\]/);
  assert.match(source, /closeSession: \(id\) => \{\s*if \(!requestDirtyDraftAction\(\[id\]/);
  assert.match(source, /closeSessions: \(ids, opts\) => \{[\s\S]*requestDirtyDraftAction\(/);
});

test("editor registers dirty state and resolves pending navigation through its discard UI", async () => {
  const source = await readFile(new URL("../src/ui/FilePreview.tsx", import.meta.url), "utf8");
  assert.match(source, /registerDirtyDraft\(\{/);
  assert.match(source, /updateDirtyDraft\(draftOwnerRef\.current, dirty\)/);
  assert.match(source, /confirmDirtyDraftDiscard\(draftOwnerRef\.current\)/);
  assert.match(source, /cancelDirtyDraftAction\(draftOwnerRef\.current\)/);
  assert.match(source, /setCloseConfirm\(false\);\s*setContent\(savedContent\);[\s\S]*discardEditorDraft\(draftKey\);\s*confirmDirtyDraftDiscard/);
});

test("native window close is guarded before persistence and hide", async () => {
  const source = await readFile(new URL("../src/app/useInit.ts", import.meta.url), "utf8");
  assert.match(source, /requestActiveDirtyDraftAction\(\(\) => \{ void finishClose\(\); \}\)/);
  assert.match(source, /if \(!requestActiveDirtyDraftAction[\s\S]*return;\s*await finishClose\(\)/);
});
