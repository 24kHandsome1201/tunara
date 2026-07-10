import assert from "node:assert/strict";
import test from "node:test";

import { currentWorkspaceWorktree, withCurrentDirtyFiles } from "../src/modules/git/workspace-context.ts";

function workspace(overrides = {}) {
  return {
    repository: {
      id: "local:/repo/.git",
      name: "repo",
      commonGitDir: "/repo/.git",
      transport: "local",
      bare: false,
    },
    currentWorktreeId: "local:/repo/.git::/repo-linked",
    worktrees: [
      { id: "local:/repo/.git::/repo", name: "repo", path: "/repo", detached: false, current: false, locked: false, available: true },
      { id: "local:/repo/.git::/repo-linked", name: "repo-linked", path: "/repo-linked", branch: "feature", detached: false, current: true, locked: false, available: true },
    ],
    ...overrides,
  };
}

test("currentWorkspaceWorktree prefers the stable current worktree id", () => {
  assert.equal(currentWorkspaceWorktree(workspace())?.path, "/repo-linked");
});

test("currentWorkspaceWorktree falls back to the current flag for degraded providers", () => {
  assert.equal(currentWorkspaceWorktree(workspace({ currentWorktreeId: undefined }))?.branch, "feature");
});

test("currentWorkspaceWorktree safely handles missing and bare contexts", () => {
  assert.equal(currentWorkspaceWorktree(undefined), undefined);
  assert.equal(currentWorkspaceWorktree(workspace({ currentWorktreeId: undefined, worktrees: [] })), undefined);
});

test("withCurrentDirtyFiles counts paths once and leaves sibling worktrees unknown", () => {
  const result = withCurrentDirtyFiles(workspace(), {
    branch: "feature",
    files: [
      { path: "both.txt", status: "M", stage: "staged", added: 1, removed: 0 },
      { path: "both.txt", status: "M", stage: "unstaged", added: 1, removed: 1 },
      { path: "new.txt", status: "?", stage: "untracked", added: 0, removed: 0 },
    ],
  });
  assert.equal(result.worktrees[1].dirtyFiles, 2);
  assert.equal(result.worktrees[0].dirtyFiles, undefined);
});
