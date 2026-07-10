import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceHydrationGroups,
  WORKSPACE_HYDRATION_CONCURRENCY,
  workspaceHydrationSignature,
} from "../src/modules/git/workspace-hydration.ts";

test("workspace hydration deduplicates local sessions by normalized directory", () => {
  const groups = buildWorkspaceHydrationGroups([
    { id: "a", dir: "/repo/" },
    { id: "b", dir: "/repo" },
    { id: "active", dir: "/other" },
  ], "active");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sessionIds, ["a", "b"]);
  assert.equal(groups[0].key, "local:/repo");
});

test("workspace hydration keeps identical remote paths separate by host", () => {
  const groups = buildWorkspaceHydrationGroups([
    { id: "one", dir: "/srv/app", ptyId: 1, remote: { user: "root", host: "one", port: 22 } },
    { id: "two", dir: "/srv/app", ptyId: 2, remote: { user: "root", host: "two", port: 22 } },
  ]);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].key, groups[1].key);
});

test("workspace hydration skips unresolved, active, and terminal states", () => {
  const groups = buildWorkspaceHydrationGroups([
    { id: "pseudo", dir: "root@example", ptyId: 1, remote: { user: "root", host: "example", port: 22 } },
    { id: "ready", dir: "/ready", workspaceState: "ready" },
    { id: "not-git", dir: "/tmp", workspaceState: "notGit" },
    { id: "active", dir: "/active" },
  ], "active");
  assert.deepEqual(groups, []);
});

test("workspace hydration signature changes on remote reconnect but not object identity", () => {
  const first = buildWorkspaceHydrationGroups([
    { id: "remote", dir: "/srv/app", ptyId: 1, remote: { user: "root", host: "one", port: 22 } },
  ]);
  const same = buildWorkspaceHydrationGroups([
    { id: "remote", dir: "/srv/app", ptyId: 1, remote: { user: "root", host: "one", port: 22 } },
  ]);
  const reconnected = buildWorkspaceHydrationGroups([
    { id: "remote", dir: "/srv/app", ptyId: 9, remote: { user: "root", host: "one", port: 22 } },
  ]);
  assert.equal(workspaceHydrationSignature(first), workspaceHydrationSignature(same));
  assert.notEqual(workspaceHydrationSignature(first), workspaceHydrationSignature(reconnected));
  assert.equal(WORKSPACE_HYDRATION_CONCURRENCY, 2);
});

test("workspace hydration bounds a large restored session set by unique sources", () => {
  const sessions = Array.from({ length: 1_000 }, (_, index) => ({
    id: `session-${index}`,
    dir: `/repo-${index % 10}`,
  }));
  const groups = buildWorkspaceHydrationGroups(sessions);
  assert.equal(groups.length, 10);
  assert.equal(groups.reduce((total, group) => total + group.sessionIds.length, 0), 1_000);
  assert.ok(groups.every((group) => group.sessionIds.length === 100));
});
