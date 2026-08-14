import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createTransferStore, useTransferStore, type TransferItem } from "@/modules/ssh/transfer-store";
import type { TransferJournalRecord } from "@/modules/ssh/transfer-bridge";
import { TransferCenter } from "@/ui/TransferCenter";
import { useSessionsStore } from "@/state/sessions";
import { mockIPC } from "@tauri-apps/api/mocks";

const request = (physicalPtyId: number) => ({
  binding: { logicalSessionId: `session-${physicalPtyId}`, physicalPtyId, transportGeneration: `generation-${physicalPtyId}` },
  direction: "upload" as const,
  source: "a",
  destination: "b",
  conflict: "replace" as const,
});
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const recoveryRecord: TransferJournalRecord = {
  recoveryId: "recovery-1", transferId: "old-transfer", attempt: 2, direction: "download",
  session: "session-1", endpoint: "one.example:22", user: "deploy", hostKey: "sha256:key",
  source: "/remote/a", sourceIdentity: { kind: "remote", path: "/remote/a", size: 3, permissions: 420 },
  finalPath: "/home/user/a", partial: { kind: "local", path: "/home/user/.a.tunara-x.partial", size: 3, dev: 1, ino: 2 },
  phase: "paused", bytes: 3, prefixSha256: "a".repeat(64), finalSha256: null,
  commitIntent: false, paused: true, needsReconcile: true,
};

beforeEach(() => {
  useTransferStore.setState({ items: [], recoveries: [] });
  useSessionsStore.setState({ sessions: [{
    id: "session-1", title: "one", dir: "/", branch: "", runState: "idle", updatedAt: 1,
    remote: { host: "one.example", port: 22, user: "deploy", authMethod: "agent" },
    ptyId: 1, transportGeneration: "generation-1",
    connection: { transport: "ssh", phase: "ready", source: "backend", updatedAt: 1 },
  }], activeSessionId: "session-1" });
});

describe("transfer queue", () => {
  it("limits global and per-connection concurrency", async () => {
    const releases: (() => void)[] = [];
    const active: TransferItem[] = [];
    const store = createTransferStore((item) => new Promise((resolve) => { active.push(item); releases.push(() => resolve({ outcome: { status: "completed", bytesTransferred: 1 } })); }));
    store.getState().enqueueBatch([request(1), request(1), request(1), request(2), request(2), request(3)]);
    await tick();
    expect(active).toHaveLength(4);
    expect(active.filter((x) => x.binding.physicalPtyId === 1)).toHaveLength(2);
    releases.forEach((release) => release());
  });

  it("cancels queued items and retries with a new attempt", async () => {
    const runner = vi.fn(async () => ({ outcome: { status: "cancelled" as const, bytesTransferred: 0, residuePath: null } }));
    const store = createTransferStore(runner);
    const id = store.getState().enqueue(request(1));
    await tick(); await tick();
    expect(store.getState().items[0].status).toBe("cancelled");
    await store.getState().retry(id, () => true);
    expect(store.getState().items[0].attempt).toBe(2);
  });

  it("holds an unknown outcome for reconciliation and forbids retry", async () => {
    const store = createTransferStore(async () => ({ outcome: {
      status: "outcomeUnknown" as const,
      bytesTransferred: 3,
      code: "outcomeUnknown" as const,
      message: "The transfer outcome is unknown. Reconcile recovery state before retrying.",
      residuePath: "/remote/.partial",
    } }));
    const id = store.getState().enqueue(request(1));
    await tick(); await tick();
    expect(store.getState().items[0].status).toBe("needsReconcile");
    store.getState().retry(id);
    expect(store.getState().items[0]).toMatchObject({ status: "needsReconcile", attempt: 1 });
  });

  it("scopes cancel all to one logical session across physical hosts", async () => {
    const store = createTransferStore(async () => new Promise(() => {}));
    const first = { ...request(1), transferId: "first", attempt: 1, status: "queued" as const, cancelRequested: false };
    const second = { ...request(2), transferId: "second", attempt: 1, status: "queued" as const, cancelRequested: false };
    store.setState({ items: [first, second] });
    await store.getState().cancelAll("session-1");
    expect(store.getState().items.find((item) => item.transferId === "first")?.status).toBe("cancelled");
    expect(store.getState().items.find((item) => item.transferId === "second")?.status).not.toBe("cancelled");
  });

  it("resolves a replacement binding for a fresh retry and rejects offline retry", async () => {
    const runner = vi.fn(async () => ({ outcome: { status: "failed" as const, bytesTransferred: 0, code: "transferFailed" as const, message: "failed", residuePath: null } }));
    const store = createTransferStore(runner);
    const transferId = store.getState().enqueue(request(1));
    await tick(); await tick();
    useSessionsStore.setState((state) => ({ sessions: state.sessions.map((session) => ({ ...session, ptyId: 9, transportGeneration: "replacement" })) }));
    const confirmReplacement = vi.fn(async () => true);
    expect(await store.getState().retry(transferId, confirmReplacement)).toBe("queued");
    expect(confirmReplacement).toHaveBeenCalledOnce();
    expect(store.getState().items[0].binding).toMatchObject({ physicalPtyId: 9, transportGeneration: "replacement" });

    await tick(); await tick();
    useSessionsStore.setState((state) => ({ sessions: state.sessions.map((session) => ({ ...session, connection: { ...session.connection!, phase: "disconnected" } })) }));
    expect(await store.getState().retry(transferId)).toBe("offline");
  });

  it("serializes retry confirmation and re-resolves a binding replaced while the dialog is open", async () => {
    const store = createTransferStore(async () => ({ outcome: { status: "failed" as const, bytesTransferred: 0, code: "transferFailed" as const, message: "failed", residuePath: null } }));
    const transferId = store.getState().enqueue(request(1));
    await tick(); await tick();
    let release!: () => void;
    const firstDecision = new Promise<void>((resolve) => { release = resolve; });
    const reasons: string[] = [];
    const confirmFresh = async (reason: "replacement" | "replace") => {
      reasons.push(reason);
      if (reasons.length === 1) await firstDecision;
      return true;
    };
    const retrying = store.getState().retry(transferId, confirmFresh);
    expect(await store.getState().retry(transferId, confirmFresh)).toBe("notRetryable");
    useSessionsStore.setState((state) => ({ sessions: state.sessions.map((session) => ({ ...session, ptyId: 8, transportGeneration: "during-dialog" })) }));
    release();
    expect(await retrying).toBe("queued");
    expect(reasons).toEqual(["replace", "replacement"]);
    expect(store.getState().items[0].binding).toMatchObject({ physicalPtyId: 8, transportGeneration: "during-dialog" });
  });

  it("bounds finished history, preserves unresolved items, and clears finished", async () => {
    const store = createTransferStore(async () => ({ outcome: { status: "completed" as const, bytesTransferred: 1 } }));
    for (let index = 0; index < 205; index++) store.getState().enqueue({ ...request(1), transferId: `done-${index}` });
    for (let index = 0; index < 1_000 && store.getState().items.some((item) => item.status === "queued" || item.status === "running"); index++) await tick();
    expect(store.getState().items.filter((item) => item.status === "completed").length).toBeLessThanOrEqual(200);
    store.setState((state) => ({ items: [...state.items, { ...request(1), transferId: "unknown", attempt: 1, status: "needsReconcile", cancelRequested: false }] }));
    store.getState().clearFinished();
    expect(store.getState().items).toHaveLength(1);
    expect(store.getState().items[0].status).toBe("needsReconcile");
  });

  it("clears finished history only inside the requested logical-session scope", () => {
    const store = createTransferStore();
    store.setState({ items: [
      { ...request(1), transferId: "one", attempt: 1, status: "completed", cancelRequested: false },
      { ...request(2), transferId: "two", attempt: 1, status: "failed", cancelRequested: false },
    ] });
    store.getState().clearFinished("session-1");
    expect(store.getState().items.map((item) => item.transferId)).toEqual(["two"]);
  });

  it("loads interrupted journal records as unresolved recovery work", async () => {
    mockIPC((command) => {
      if (command !== "ssh_transfer_journal_load") throw new Error(`unexpected command: ${command}`);
      return [recoveryRecord];
    });
    const store = createTransferStore();
    await store.getState().loadJournal();
    expect(store.getState()).toMatchObject({
      journalLoaded: true,
      recoveries: [{ busy: false, record: { recoveryId: "recovery-1", needsReconcile: true } }],
    });
  });

  it("clears an unknown outcome and residue only after verified reconciliation", async () => {
    mockIPC((command) => {
      if (command !== "ssh_transfer_recovery_reconcile") throw new Error(`unexpected command: ${command}`);
      return { record: recoveryRecord, observation: "finalMatches", completed: true };
    });
    const store = createTransferStore();
    store.setState({
      items: [{
        ...request(1), transferId: recoveryRecord.transferId, attempt: recoveryRecord.attempt,
        status: "needsReconcile", cancelRequested: false,
        outcome: { status: "outcomeUnknown", bytesTransferred: 3, code: "outcomeUnknown", message: "unknown", residuePath: recoveryRecord.partial.path },
      }],
      recoveries: [{ record: recoveryRecord, busy: false }],
    });
    expect(await store.getState().reconcileRecovery(recoveryRecord.recoveryId)).toBe("completed");
    expect(store.getState().items[0]).toMatchObject({
      status: "completed",
      outcome: { status: "completed", bytesTransferred: 3 },
    });
    expect("residuePath" in store.getState().items[0].outcome!).toBe(false);
  });

  it("unlocks restart recovery after unsupported cleanup and permits a later retry", async () => {
    let cleanupAttempts = 0;
    mockIPC((command) => {
      if (command !== "ssh_transfer_journal_cleanup") throw new Error(`unexpected command: ${command}`);
      cleanupAttempts += 1;
      return cleanupAttempts > 1;
    });
    const runner = vi.fn(async () => ({ outcome: { status: "completed" as const, bytesTransferred: 3 } }));
    const store = createTransferStore(runner);
    store.setState({ recoveries: [{ record: recoveryRecord, busy: false }] });

    expect(await store.getState().restartRecovery(recoveryRecord.recoveryId)).toBe("unsupported");
    expect(store.getState().recoveries[0]).toMatchObject({ busy: false, error: "unsupported" });

    expect(await store.getState().restartRecovery(recoveryRecord.recoveryId)).toBe("queued");
    expect(store.getState().recoveries).toEqual([]);
    await tick();
    expect(runner).toHaveBeenCalledOnce();
  });

  it("unlocks restart recovery after cleanup rejects and exposes a retryable typed error", async () => {
    let cleanupAttempts = 0;
    mockIPC((command) => {
      if (command !== "ssh_transfer_journal_cleanup") throw new Error(`unexpected command: ${command}`);
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("cleanup failed");
      return true;
    });
    const runner = vi.fn(async () => ({ outcome: { status: "completed" as const, bytesTransferred: 3 } }));
    const store = createTransferStore(runner);
    store.setState({ recoveries: [{ record: recoveryRecord, busy: false }] });

    expect(await store.getState().restartRecovery(recoveryRecord.recoveryId)).toBe("failed");
    expect(store.getState().recoveries[0]).toMatchObject({ busy: false, error: "failed" });

    expect(await store.getState().restartRecovery(recoveryRecord.recoveryId)).toBe("queued");
    expect(store.getState().recoveries).toEqual([]);
    await tick();
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe("Transfer Center announcements", () => {
  it("shows an explanatory empty state without meaningless bulk actions", () => {
    render(<TransferCenter inspectorScope={{ kind: "logical-session", key: "session:session-1", logicalSessionId: "session-1" }} />);

    expect(screen.getByRole("heading", { level: 2, name: "Session transfers" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("No transfers");
    expect(screen.queryByRole("button", { name: "View all sessions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel all transfers in this session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear finished" })).toBeNull();
  });

  it("shows and cancels only transfers in the declared logical-session scope", async () => {
    mockIPC((command) => command === "plugin:dialog|message" ? "Ok" : undefined);
    const first: TransferItem = { ...request(1), source: "first", transferId: "first", attempt: 1, status: "queued", cancelRequested: false };
    const second: TransferItem = { ...request(2), source: "second", transferId: "second", attempt: 1, status: "completed", cancelRequested: false };
    useTransferStore.setState({ items: [first, second] });
    render(<TransferCenter inspectorScope={{ kind: "logical-session", key: "session:session-1", logicalSessionId: "session-1" }} />);

    expect(screen.getByRole("button", { name: "Cancel first" })).toBeTruthy();
    expect(screen.queryByText(/second/)).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "Cancel all transfers in this session" }).click();
      await tick();
    });
    expect(useTransferStore.getState().items.find((item) => item.transferId === "first")?.status).toBe("cancelled");
    expect(useTransferStore.getState().items.find((item) => item.transferId === "second")?.status).toBe("completed");
    useTransferStore.setState({ items: [] });
  });

  it("announces start, each 10 percent or two seconds, cancellation, and terminal states", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const item: TransferItem = {
      ...request(1), transferId: "live-1", attempt: 1, status: "queued", cancelRequested: false,
    };
    useTransferStore.setState({ items: [item] });
    try {
      render(<TransferCenter />);
      expect(screen.getByText("Transfer started: a")).toBeTruthy();

      act(() => useTransferStore.setState({ items: [{ ...item, status: "running", event: { transferId: "live-1", attempt: 1, sequence: 1, phase: "transferring", bytesTransferred: 9, totalBytes: 100 } }] }));
      expect(screen.getByText("Transfer started: a")).toBeTruthy();
      act(() => useTransferStore.setState({ items: [{ ...item, status: "running", event: { transferId: "live-1", attempt: 1, sequence: 2, phase: "transferring", bytesTransferred: 10, totalBytes: 100 } }] }));
      expect(screen.getByText("Transfer progress: a, 10%")).toBeTruthy();

      vi.setSystemTime(3_001);
      act(() => useTransferStore.setState({ items: [{ ...item, status: "running", event: { transferId: "live-1", attempt: 1, sequence: 3, phase: "transferring", bytesTransferred: 11, totalBytes: 100 } }] }));
      expect(screen.getByText("Transfer progress: a, 11%")).toBeTruthy();

      act(() => useTransferStore.setState({ items: [{ ...item, status: "cancelled" }] }));
      expect(screen.getByText("Transfer cancelled: a")).toBeTruthy();
      act(() => useTransferStore.setState({ items: [{ ...item, status: "completed" }] }));
      expect(screen.getByText("Transfer completed: a")).toBeTruthy();
    } finally {
      useTransferStore.setState({ items: [] });
      vi.useRealTimers();
    }
  });
});
