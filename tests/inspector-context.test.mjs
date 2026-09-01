import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUnreviewedGitChanges,
  isViewingInspectorFiles,
  resolveInspectorAutoSwitch,
  resolveInspectorAutoView,
  sessionHasInProgressTransfer,
} from "../src/ui/inspector-context.ts";

test("auto view prefers unreviewed changes, then opened Preview, then transfers, else Files", () => {
  const base = {
    isRemote: false,
    hasUnreviewedChanges: false,
    previewOpened: false,
    hasActivePreviewSource: false,
    hasInProgressTransfer: false,
  };
  assert.equal(resolveInspectorAutoView(base), "files");
  assert.equal(resolveInspectorAutoView({ ...base, hasUnreviewedChanges: true }), "changes");
  assert.equal(resolveInspectorAutoView({
    ...base,
    hasUnreviewedChanges: true,
    previewOpened: true,
    hasActivePreviewSource: true,
    hasInProgressTransfer: true,
    isRemote: true,
  }), "changes");
  assert.equal(resolveInspectorAutoView({
    ...base,
    previewOpened: true,
    hasActivePreviewSource: true,
  }), "preview");
  assert.equal(resolveInspectorAutoView({
    ...base,
    previewOpened: false,
    hasActivePreviewSource: true,
  }), "files");
  assert.equal(resolveInspectorAutoView({
    ...base,
    isRemote: true,
    hasInProgressTransfer: true,
  }), "transfers");
  assert.equal(resolveInspectorAutoView({
    ...base,
    isRemote: false,
    hasInProgressTransfer: true,
  }), "files");
});

test("auto switch never jumps while locked or while Files is being read", () => {
  assert.deepEqual(resolveInspectorAutoSwitch({
    locked: true,
    current: "files",
    recommended: "changes",
    viewingFiles: false,
  }), { recommended: "changes", apply: false, defer: false });

  assert.deepEqual(resolveInspectorAutoSwitch({
    locked: false,
    current: "files",
    recommended: "changes",
    viewingFiles: true,
  }), { recommended: "changes", apply: false, defer: true });

  assert.deepEqual(resolveInspectorAutoSwitch({
    locked: false,
    current: "files",
    recommended: "changes",
    viewingFiles: false,
  }), { recommended: "changes", apply: true, defer: false });

  assert.deepEqual(resolveInspectorAutoSwitch({
    locked: false,
    current: "changes",
    recommended: "changes",
    viewingFiles: false,
  }), { recommended: "changes", apply: false, defer: false });
});

test("unreviewed git changes and transfer progress helpers stay conservative", () => {
  assert.equal(hasUnreviewedGitChanges({ reviewChangesHint: true, changes: { files: [{ path: "a.ts" }] } }), true);
  assert.equal(hasUnreviewedGitChanges({ reviewChangesHint: false, changes: { files: [{ path: "a.ts" }] } }), false);
  assert.equal(hasUnreviewedGitChanges({ reviewChangesHint: true, changes: { files: [] } }), false);
  assert.equal(sessionHasInProgressTransfer({ queued: 1, running: 0 }), true);
  assert.equal(sessionHasInProgressTransfer({ queued: 0, running: 2 }), true);
  assert.equal(sessionHasInProgressTransfer({ queued: 0, running: 0 }), false);
  assert.equal(sessionHasInProgressTransfer(undefined), false);
  assert.equal(isViewingInspectorFiles({ currentTab: "files", hasActiveFileTab: true }), true);
  assert.equal(isViewingInspectorFiles({ currentTab: "files", hasActiveFileTab: false }), false);
  assert.equal(isViewingInspectorFiles({ currentTab: "changes", hasActiveFileTab: true }), false);
});
