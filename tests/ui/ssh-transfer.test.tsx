import { describe, expect, test } from "vitest";
import { acceptSshTransferEvent, type SshTransferEvent } from "@/modules/ssh/transfer-bridge";

function event(sequence: number, overrides: Partial<SshTransferEvent> = {}): SshTransferEvent {
  return {
    transferId: "transfer-1",
    attempt: 1,
    sequence,
    phase: "transferring",
    bytesTransferred: sequence * 10,
    totalBytes: 100,
    ...overrides,
  };
}

describe("SSH transfer event ordering", () => {
  test("accepts only a strictly newer sequence for the same attempt", () => {
    const current = event(4);
    expect(acceptSshTransferEvent(current, event(5))).toEqual(event(5));
    expect(acceptSshTransferEvent(current, event(4))).toBe(current);
    expect(acceptSshTransferEvent(current, event(3))).toBe(current);
  });

  test("does not let stale attempts or another transfer overwrite state", () => {
    const current = event(4);
    expect(acceptSshTransferEvent(current, event(9, { attempt: 2 }))).toBe(current);
    expect(acceptSshTransferEvent(current, event(9, { transferId: "transfer-2" }))).toBe(current);
  });
});
