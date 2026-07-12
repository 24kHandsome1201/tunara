import test from "node:test";
import assert from "node:assert/strict";

import {
  isCanonicalSshWriteFingerprint,
  isCanonicalSshWriteMode,
  parseSshWriteOutcomeUnknown,
  requireSshWriteReconcileFields,
} from "../src/modules/ssh/ssh-write-reconcile.ts";

const fingerprint = "a".repeat(64);

test("parses the canonical backend token and preserves cleanup state", () => {
  assert.deepEqual(
    parseSshWriteOutcomeUnknown(`outcomeUnknown:${fingerprint}:640:cleanupPending=true`),
    {
      token: `outcomeUnknown:${fingerprint}:640:cleanupPending=true`,
      attemptedFingerprint: fingerprint,
      expectedMode: 0o640,
      cleanupPending: true,
    },
  );
  assert.equal(parseSshWriteOutcomeUnknown(`outcomeUnknown:${fingerprint}:0:cleanupPending=false`)?.expectedMode, 0);
});

test("rejects malformed, non-canonical, prefixed, or over-permissive tokens", () => {
  const invalid = [
    null,
    {},
    `error:outcomeUnknown:${fingerprint}:640:cleanupPending=true`,
    `outcomeUnknown:${fingerprint.toUpperCase()}:640:cleanupPending=true`,
    `outcomeUnknown:${"a".repeat(63)}:640:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:0640:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:888:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:10000:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:640:cleanupPending=1`,
    `outcomeUnknown:${fingerprint}:640:cleanupPending=TRUE`,
    `outcomeUnknown:${fingerprint}:640:cleanupPending=true\n`,
  ];
  for (const value of invalid) assert.equal(parseSshWriteOutcomeUnknown(value), null, String(value));
});

test("typed reconcile fields use the same strict fingerprint and mode bounds", () => {
  assert.equal(isCanonicalSshWriteFingerprint(fingerprint), true);
  assert.equal(isCanonicalSshWriteFingerprint("A".repeat(64)), false);
  assert.equal(isCanonicalSshWriteMode(0o7777), true);
  assert.equal(isCanonicalSshWriteMode(0o10000), false);
  assert.equal(isCanonicalSshWriteMode(1.5), false);
  assert.doesNotThrow(() => requireSshWriteReconcileFields(fingerprint, 0o640));
  assert.throws(() => requireSshWriteReconcileFields("bad", 0o640), /fingerprint/);
  assert.throws(() => requireSshWriteReconcileFields(fingerprint, 0o10000), /mode/);
});
