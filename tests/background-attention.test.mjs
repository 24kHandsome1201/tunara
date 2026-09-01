import assert from "node:assert/strict";
import test from "node:test";

import {
  agentConfirmationAttentionKey,
  forgetBackgroundAttention,
  peekBackgroundAttentionKeys,
  rememberBackgroundAttention,
  resetBackgroundAttention,
} from "../src/ui/lib/background-attention-state.ts";

test("background attention remembers each event key once", () => {
  resetBackgroundAttention();
  assert.equal(rememberBackgroundAttention(""), false);
  assert.equal(rememberBackgroundAttention(agentConfirmationAttentionKey("s-1")), true);
  assert.equal(rememberBackgroundAttention(agentConfirmationAttentionKey("s-1")), false);
  assert.equal(rememberBackgroundAttention(agentConfirmationAttentionKey("s-2")), true);
  forgetBackgroundAttention(agentConfirmationAttentionKey("s-1"));
  assert.equal(rememberBackgroundAttention(agentConfirmationAttentionKey("s-1")), true);
  resetBackgroundAttention();
  assert.deepEqual(peekBackgroundAttentionKeys(), []);
});
