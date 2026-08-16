import assert from "node:assert/strict";
import test from "node:test";

import { shouldShowReviewChangesHint } from "../src/modules/session/review-changes-hint.ts";

test("review-changes hint waits for an idle agent with dirty files", () => {
  const base = {
    id: "s1",
    title: "Agent",
    dir: "/repo",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    agent: "CC",
    agentActivity: "idle",
    reviewChangesHint: true,
    changes: { files: [{ path: "a.ts", status: "modified" }] },
  };
  assert.equal(shouldShowReviewChangesHint(base), true);
  assert.equal(shouldShowReviewChangesHint({ ...base, reviewChangesHint: false }), false);
  assert.equal(shouldShowReviewChangesHint({ ...base, agentActivity: "running" }), false);
  assert.equal(shouldShowReviewChangesHint({ ...base, agent: undefined }), false);
  assert.equal(shouldShowReviewChangesHint({ ...base, changes: { files: [] } }), false);
});
