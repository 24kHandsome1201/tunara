const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANONICAL_OCTAL_MODE = /^(?:0|[1-7][0-7]{0,3})$/;
const OUTCOME_UNKNOWN = /^outcomeUnknown:([0-9a-f]{64}):(0|[1-7][0-7]{0,3}):lockOwner=([0-9a-f]{64}):cleanupPending=(true|false)$/;

export interface SshWriteOutcomeUnknown {
  token: string;
  attemptedFingerprint: string;
  expectedMode: number;
  replaceLockOwner: string;
  cleanupPending: boolean;
}

export function isCanonicalSshWriteFingerprint(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function isCanonicalSshWriteMode(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0o7777;
}

export function parseSshWriteOutcomeUnknown(value: unknown): SshWriteOutcomeUnknown | null {
  if (typeof value !== "string") return null;
  const match = OUTCOME_UNKNOWN.exec(value);
  if (!match || !CANONICAL_OCTAL_MODE.test(match[2])) return null;
  const expectedMode = Number.parseInt(match[2], 8);
  if (!isCanonicalSshWriteMode(expectedMode)) return null;
  return {
    token: value,
    attemptedFingerprint: match[1],
    expectedMode,
    replaceLockOwner: match[3],
    cleanupPending: match[4] === "true",
  };
}

export function requireSshWriteReconcileFields(
  attemptedFingerprint: string,
  expectedMode: number,
  replaceLockOwner: string,
): void {
  if (!isCanonicalSshWriteFingerprint(attemptedFingerprint)) {
    throw new Error("invalid SSH write reconcile fingerprint");
  }
  if (!isCanonicalSshWriteMode(expectedMode)) {
    throw new Error("invalid SSH write reconcile mode");
  }
  if (!isCanonicalSshWriteFingerprint(replaceLockOwner)) {
    throw new Error("invalid SSH write reconcile lock owner");
  }
}
