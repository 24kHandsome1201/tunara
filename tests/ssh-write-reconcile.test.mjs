import test from "node:test";
import assert from "node:assert/strict";

import {
  isCanonicalSshWriteFingerprint,
  isCanonicalSshWriteMode,
  parseSshWriteOutcomeUnknown,
  requireSshWriteReconcileFields,
} from "../src/modules/ssh/ssh-write-reconcile.ts";

const fingerprint = "a".repeat(64);
const lockOwner = "b".repeat(64);
const token = `outcomeUnknown:${fingerprint}:640:lockOwner=${lockOwner}:cleanupPending=true`;

test("parses the canonical backend token and preserves cleanup state", () => {
  assert.deepEqual(
    parseSshWriteOutcomeUnknown(token),
    {
      token,
      attemptedFingerprint: fingerprint,
      expectedMode: 0o640,
      replaceLockOwner: lockOwner,
      cleanupPending: true,
    },
  );
  assert.equal(parseSshWriteOutcomeUnknown(`outcomeUnknown:${fingerprint}:0:lockOwner=${lockOwner}:cleanupPending=false`)?.expectedMode, 0);
});

test("rejects malformed, non-canonical, prefixed, or over-permissive tokens", () => {
  const invalid = [
    null,
    {},
    `error:${token}`,
    `outcomeUnknown:${fingerprint.toUpperCase()}:640:lockOwner=${lockOwner}:cleanupPending=true`,
    `outcomeUnknown:${"a".repeat(63)}:640:lockOwner=${lockOwner}:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:0640:lockOwner=${lockOwner}:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:888:lockOwner=${lockOwner}:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:10000:lockOwner=${lockOwner}:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:640:lockOwner=${"B".repeat(64)}:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:640:lockOwner=bad:cleanupPending=true`,
    `outcomeUnknown:${fingerprint}:640:lockOwner=${lockOwner}:cleanupPending=1`,
    `outcomeUnknown:${fingerprint}:640:lockOwner=${lockOwner}:cleanupPending=TRUE`,
    `${token}\n`,
  ];
  for (const value of invalid) assert.equal(parseSshWriteOutcomeUnknown(value), null, String(value));
});

test("typed reconcile fields use the same strict fingerprint and mode bounds", () => {
  assert.equal(isCanonicalSshWriteFingerprint(fingerprint), true);
  assert.equal(isCanonicalSshWriteFingerprint("A".repeat(64)), false);
  assert.equal(isCanonicalSshWriteMode(0o7777), true);
  assert.equal(isCanonicalSshWriteMode(0o10000), false);
  assert.equal(isCanonicalSshWriteMode(1.5), false);
  assert.doesNotThrow(() => requireSshWriteReconcileFields(fingerprint, 0o640, lockOwner));
  assert.throws(() => requireSshWriteReconcileFields("bad", 0o640, lockOwner), /fingerprint/);
  assert.throws(() => requireSshWriteReconcileFields(fingerprint, 0o10000, lockOwner), /mode/);
  assert.throws(() => requireSshWriteReconcileFields(fingerprint, 0o640, "bad"), /lock owner/);
});
