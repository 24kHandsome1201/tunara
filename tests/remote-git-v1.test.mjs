import assert from "node:assert/strict";
import test from "node:test";
import { deriveRemoteGitState, forceForNonce, snapshotMatches } from "../src/modules/git/remote-git-state.ts";

const binding = { logicalSessionId: "s", physicalPtyId: 7, transportGeneration: "tg" };
const base = { requestId: "r", generation: 3, binding, observedAt: 1, freshness: "fresh", unavailableFields: [] };

test("nested wire derives compatibility state", () => {
  assert.equal(deriveRemoteGitState({ ...base, repo: { status: { branch: "main", files: [] }, upstream: { state: "noUpstream", branch: "main" } } }), "repo");
  assert.equal(deriveRemoteGitState({ ...base, error: { kind: "notRepository", retryable: false } }), "notGit");
  assert.equal(deriveRemoteGitState({ ...base, error: { kind: "timeout", retryable: true } }), "unknown");
});

test("force applies only to the nonce transition", () => {
  assert.equal(forceForNonce(0, 1), true);
  assert.equal(forceForNonce(1, 1), false);
});

test("late result guard checks request, generation, and complete binding", () => {
  assert.equal(snapshotMatches(base, "r", 3, binding), true);
  assert.equal(snapshotMatches({ ...base, generation: 2 }, "r", 3, binding), false);
  assert.equal(snapshotMatches({ ...base, binding: { ...binding, transportGeneration: "old" } }, "r", 3, binding), false);
});
