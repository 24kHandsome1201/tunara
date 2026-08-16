import { create } from "zustand";
import {
  acceptSshTransferEvent, sshTransferCancel, sshTransferDownload, sshTransferUpload,
  sshTransferJournalCleanup, sshTransferJournalLoad, sshTransferRecoveryDismiss,
  sshTransferRecoveryReconcile, type SshTransferEvent, type SshTransferOutcome,
  type TransferJournalRecord,
} from "./transfer-bridge";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { currentReadySessionBinding } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { t } from "@/modules/i18n";
import { localUsageDuration, localUsageErrorCategory, recordLocalUsageEvent } from "@/modules/usage-log/local-usage-log";
import { pushRateSample, type TransferRateSample } from "./transfer-rate";
import { canResumeRecovery } from "./transfer-resume";

export type TransferConflict = "skip" | "replace" | "rename";
export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | "needsReconcile";
export interface TransferRequest {
  transferId?: string; batchId?: string; binding: SessionBindingV1; direction: TransferDirection;
  source: string; destination: string; conflict: TransferConflict;
  resumeFrom?: number; resumePartial?: string; createParents?: boolean;
}
export interface TransferItem extends Required<Omit<TransferRequest, "batchId" | "transferId" | "resumeFrom" | "resumePartial" | "createParents">> {
  transferId: string; batchId?: string; attempt: number; status: TransferStatus;
  event?: SshTransferEvent; outcome?: SshTransferOutcome; error?: string; cancelRequested: boolean;
  resumeFrom?: number; resumePartial?: string; createParents?: boolean;
  rateSamples?: TransferRateSample[]; startedAt?: number;
}
export interface TransferRecoveryItem {
  record: TransferJournalRecord;
  observation?: "partialMatches" | "finalMatches" | "finalAndPartialMatch";
  busy: boolean;
  error?: "offline" | "identityMismatch" | "unsupported" | "failed";
}
type Runner = (item: TransferItem, event: (value: SshTransferEvent) => void) => Promise<{ outcome: SshTransferOutcome }>;
export interface TransferState {
  items: TransferItem[];
  recoveries: TransferRecoveryItem[]; journalLoaded: boolean;
  enqueue(request: TransferRequest): string; enqueueBatch(requests: TransferRequest[], batchId?: string): string[];
  cancel(transferId: string): Promise<void>; cancelBatch(batchId: string): Promise<void>; cancelAll(logicalSessionId?: string): Promise<void>;
  retry(transferId: string, confirmFresh?: (reason: "replacement" | "replace") => boolean | Promise<boolean>): Promise<"queued" | "offline" | "replacementDeclined" | "notRetryable">;
  clearFinished(logicalSessionId?: string): void;
  loadJournal(): Promise<void>;
  reconcileRecovery(recoveryId: string): Promise<"completed" | "partial" | "offline" | "failed">;
  deleteRecoveryPartial(recoveryId: string): Promise<"deleted" | "unsupported" | "failed">;
  restartRecovery(recoveryId: string): Promise<"queued" | "offline" | "unsupported" | "failed">;
  resumeRecovery(recoveryId: string): Promise<"queued" | "offline" | "unsupported" | "failed">;
  dismissRecovery(recoveryId: string): Promise<void>;
}

const id = () => globalThis.crypto?.randomUUID?.() ?? `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const defaultRunner: Runner = (item, event) => {
  const options = {
    resumeFrom: item.resumeFrom,
    resumePartial: item.resumePartial,
    createParents: item.createParents,
  };
  return item.direction === "upload"
    ? sshTransferUpload(item.binding, item.transferId, item.attempt, item.source, item.destination, item.conflict === "replace", event, options)
    : sshTransferDownload(item.binding, item.transferId, item.attempt, item.source, item.destination, event, options);
};
const FINISHED_LIMIT = 200;
const UNRESOLVED_LIMIT = 200;
const active = (item: TransferItem) => item.status === "queued" || item.status === "running";
const boundHistory = (items: TransferItem[]) => {
  const finished = items.filter((item) => !active(item));
  const unresolved = finished.filter((item) => item.status === "needsReconcile");
  const resolved = finished.filter((item) => item.status !== "needsReconcile");
  const remove = new Set([
    ...unresolved.slice(0, Math.max(0, unresolved.length - UNRESOLVED_LIMIT)),
    ...resolved.slice(0, Math.max(0, resolved.length - FINISHED_LIMIT)),
  ]);
  return items.filter((item) => !remove.has(item));
};
const recoveryError = (error: unknown): TransferRecoveryItem["error"] => {
  const message = String(error).toLowerCase();
  if (message.includes("identity") || message.includes("hash") || message.includes("changed")) return "identityMismatch";
  if (message.includes("unsupported")) return "unsupported";
  return "failed";
};

function recordTransferRecovery(
  record: TransferJournalRecord,
  recoveryId: string,
  operation: "reconcile" | "delete_partial" | "restart" | "dismiss",
  outcome: "completed" | "failed" | "scheduled" | "skipped" | "outcome_unknown",
  startedAt: number,
  errorCategory?: "disconnected" | "io" | "unsupported" | "unknown",
): void {
  recordLocalUsageEvent({
    event: "ssh.transfer.recovery",
    sessionId: record.session ?? undefined,
    correlationId: recoveryId,
    durationMs: localUsageDuration(startedAt),
    success: outcome === "completed" || outcome === "scheduled",
    outcome,
    errorCategory,
    attributes: {
      direction: record.direction === "upload" ? "upload" : "download",
      operation,
      attempt: String(record.attempt),
    },
  });
}

/** UI scheduling is advisory; Rust independently enforces the same limits. */
export function createTransferStore(run: Runner = defaultRunner) {
  let pumping = false;
  const pendingRetries = new Set<string>();
  const useStore = create<TransferState>((set, get) => {
    const pump = () => {
      if (pumping) return; pumping = true;
      queueMicrotask(() => {
        pumping = false;
        const state = get();
        const running = state.items.filter((x) => x.status === "running");
        let global = running.length;
        const connections = new Map<number, number>();
        for (const item of running) connections.set(item.binding.physicalPtyId, (connections.get(item.binding.physicalPtyId) ?? 0) + 1);
        for (const item of state.items) {
          if (global >= 4 || item.status !== "queued" || item.cancelRequested) continue;
          const count = connections.get(item.binding.physicalPtyId) ?? 0;
          if (count >= 2) continue;
          global++; connections.set(item.binding.physicalPtyId, count + 1);
          set((s) => ({ items: s.items.map((x) => x === item ? { ...x, status: "running", startedAt: Date.now(), rateSamples: [] } : x) }));
          const startedAt = Date.now();
          void run(item, (event) => set((s) => ({ items: s.items.map((x) => {
            if (x.transferId !== item.transferId || x.attempt !== item.attempt) return x;
            const nextEvent = acceptSshTransferEvent(x.event, event);
            return {
              ...x,
              event: nextEvent,
              rateSamples: pushRateSample(x.rateSamples ?? [], { at: Date.now(), bytes: nextEvent?.bytesTransferred ?? 0 }),
            };
          }) })))
            .then(({ outcome }) => {
              const outcomeName = outcome.status === "completed" ? "completed"
                : outcome.status === "cancelled" ? "cancelled"
                  : outcome.status === "outcomeUnknown" ? "outcome_unknown" : "failed";
              recordLocalUsageEvent({
                event: "ssh.transfer.finished",
                sessionId: item.binding.logicalSessionId,
                correlationId: item.transferId,
                durationMs: localUsageDuration(startedAt),
                success: outcome.status === "completed",
                outcome: outcomeName,
                errorCategory: outcome.status === "completed" ? undefined : outcome.status === "cancelled" ? "cancelled" : "io",
                attributes: { direction: item.direction, operation: item.direction, attempt: String(item.attempt) },
              });
              set((s) => ({ items: boundHistory(s.items.map((x) => x.transferId === item.transferId && x.attempt === item.attempt
                ? { ...x, outcome, status: outcome.status === "completed" ? "completed" : outcome.status === "cancelled" ? "cancelled" : outcome.status === "outcomeUnknown" ? "needsReconcile" : "failed" } : x)) }));
              if (outcome.status === "completed" && item.direction === "upload" && !item.batchId) {
                useUIStore.getState().addToast({
                  sessionId: item.binding.logicalSessionId,
                  title: t("explorer.upload.complete"),
                  subtitle: item.destination,
                  variant: "success",
                  action: {
                    kind: "open-remote-preview",
                    sessionId: item.binding.logicalSessionId,
                    path: item.destination,
                    label: t("explorer.upload.preview"),
                  },
                });
              }
              if (outcome.status === "outcomeUnknown" || ("residuePath" in outcome && outcome.residuePath)) void get().loadJournal();
            })
            .catch((error: unknown) => {
              recordLocalUsageEvent({
                event: "ssh.transfer.finished",
                sessionId: item.binding.logicalSessionId,
                correlationId: item.transferId,
                durationMs: localUsageDuration(startedAt),
                success: false,
                outcome: "failed",
                errorCategory: localUsageErrorCategory(error),
                attributes: { direction: item.direction, operation: item.direction, attempt: String(item.attempt) },
              });
              set((s) => ({ items: boundHistory(s.items.map((x) => x.transferId === item.transferId && x.attempt === item.attempt
                ? { ...x, status: "failed", error: error instanceof Error ? error.message : String(error) } : x)) }));
            })
            .finally(pump);
        }
      });
    };
    const enqueue = (request: TransferRequest) => {
      const transferId = request.transferId ?? id();
      const item: TransferItem = { ...request, transferId, attempt: 1, status: request.conflict === "skip" ? "cancelled" : "queued", cancelRequested: false };
      recordLocalUsageEvent({
        event: "ssh.transfer.queued",
        sessionId: request.binding.logicalSessionId,
        correlationId: transferId,
        success: request.conflict !== "skip",
        outcome: request.conflict === "skip" ? "skipped" : "scheduled",
        attributes: { direction: request.direction, operation: request.direction, attempt: "1" },
      });
      set((s) => ({ items: boundHistory([...s.items, item]) })); pump(); return transferId;
    };
    return {
      items: [], recoveries: [], journalLoaded: false, enqueue,
      enqueueBatch: (requests, batchId = id()) => requests.map((request) => enqueue({ ...request, batchId })),
      cancel: async (transferId) => {
        const item = get().items.find((x) => x.transferId === transferId); if (!item) return;
        set((s) => ({ items: boundHistory(s.items.map((x) => x.transferId === transferId ? { ...x, cancelRequested: true, status: x.status === "queued" ? "cancelled" : x.status } : x)) }));
        if (item.status === "running") await sshTransferCancel(item.transferId, item.attempt); pump();
        recordLocalUsageEvent({
          event: "ssh.transfer.cancelled",
          sessionId: item.binding.logicalSessionId,
          correlationId: item.transferId,
          success: true,
          outcome: "cancelled",
          attributes: { direction: item.direction, operation: "cancel", attempt: String(item.attempt) },
        });
      },
      cancelBatch: async (batchId) => {
        await Promise.all(get().items
          .filter((item) => item.batchId === batchId && active(item))
          .map((item) => get().cancel(item.transferId)));
      },
      cancelAll: async (logicalSessionId) => { await Promise.all(get().items.filter((x) => (!logicalSessionId || x.binding.logicalSessionId === logicalSessionId) && (x.status === "queued" || x.status === "running")).map((x) => get().cancel(x.transferId))); },
      retry: async (transferId, confirmFresh) => {
        const item = get().items.find((x) => x.transferId === transferId);
        if (!item || (item.status !== "failed" && item.status !== "cancelled") || pendingRetries.has(transferId)) return "notRetryable";
        pendingRetries.add(transferId);
        try {
          const originalAttempt = item.attempt;
          const resolved = currentReadySessionBinding(item.binding.logicalSessionId);
          if (!resolved) return "offline";
          let binding = resolved;
          const replacement = binding.physicalPtyId !== item.binding.physicalPtyId
            || binding.transportGeneration !== item.binding.transportGeneration;
          if ((item.conflict === "replace" || replacement)
            && !(await confirmFresh?.(item.conflict === "replace" ? "replace" : "replacement"))) return "replacementDeclined";
          const stillRetryable = () => get().items.find((candidate) => candidate.transferId === transferId
            && candidate.attempt === originalAttempt && (candidate.status === "failed" || candidate.status === "cancelled"));
          if (!stillRetryable()) return "notRetryable";
          const latest = currentReadySessionBinding(item.binding.logicalSessionId);
          if (!latest) return "offline";
          if (latest.physicalPtyId !== binding.physicalPtyId || latest.transportGeneration !== binding.transportGeneration) {
            if (!(await confirmFresh?.("replacement")) || !stillRetryable()) return "replacementDeclined";
            const confirmed = currentReadySessionBinding(item.binding.logicalSessionId);
            if (!confirmed) return "offline";
            binding = confirmed;
          }
          set((s) => ({ items: s.items.map((x) => x.transferId === transferId && x.attempt === originalAttempt
            && (x.status === "failed" || x.status === "cancelled")
            ? { ...x, binding, attempt: x.attempt + 1, status: "queued", outcome: undefined, error: undefined, event: undefined, cancelRequested: false } : x) }));
          recordLocalUsageEvent({
            event: "ssh.transfer.retry",
            sessionId: binding.logicalSessionId,
            correlationId: transferId,
            success: true,
            outcome: "scheduled",
            attributes: { direction: item.direction, operation: "retry", attempt: String(originalAttempt + 1) },
          });
          pump(); return "queued";
        } finally {
          pendingRetries.delete(transferId);
        }
      },
      clearFinished: (logicalSessionId) => set((s) => ({ items: s.items.filter((item) => active(item) || item.status === "needsReconcile"
        || (logicalSessionId !== undefined && item.binding.logicalSessionId !== logicalSessionId)) })),
      loadJournal: async () => {
        try {
          const records = await sshTransferJournalLoad();
          set({ recoveries: records.map((record) => ({ record, busy: false })), journalLoaded: true });
        } catch {
          set({ journalLoaded: true });
        }
      },
      reconcileRecovery: async (recoveryId) => {
        const recovery = get().recoveries.find((item) => item.record.recoveryId === recoveryId);
        if (!recovery) return "failed";
        const startedAt = Date.now();
        const resolved = currentReadySessionBinding(recovery.record.session);
        if (!resolved) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery ? { ...item, error: "offline" } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "reconcile", "failed", startedAt, "disconnected");
          return "offline";
        }
        set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery ? { ...item, busy: true, error: undefined } : item) }));
        try {
          const result = await sshTransferRecoveryReconcile(resolved, recoveryId);
          if (result.completed) {
            set((s) => ({
              recoveries: s.recoveries.filter((item) => item.record.recoveryId !== recoveryId),
              items: boundHistory(s.items.map((item) => item.transferId === recovery.record.transferId
                && item.attempt === recovery.record.attempt && item.status === "needsReconcile"
                ? {
                    ...item,
                    status: "completed",
                    outcome: { status: "completed", bytesTransferred: result.record.bytes },
                    error: undefined,
                  } : item)),
            }));
            recordTransferRecovery(recovery.record, recoveryId, "reconcile", "completed", startedAt);
            return "completed";
          }
          set((s) => ({ recoveries: s.recoveries.map((item) => item.record.recoveryId === recoveryId
            ? { ...item, record: result.record, observation: result.observation, busy: false } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "reconcile", "outcome_unknown", startedAt);
          return "partial";
        } catch (error) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item.record.recoveryId === recoveryId
            ? { ...item, busy: false, error: recoveryError(error) } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "reconcile", "failed", startedAt, localUsageErrorCategory(error) === "disconnected" ? "disconnected" : "io");
          return "failed";
        }
      },
      deleteRecoveryPartial: async (recoveryId) => {
        const recovery = get().recoveries.find((item) => item.record.recoveryId === recoveryId);
        if (!recovery) return "failed";
        const startedAt = Date.now();
        if (recovery.record.partial.kind === "remote") {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery ? { ...item, error: "unsupported" } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "delete_partial", "skipped", startedAt, "unsupported");
          return "unsupported";
        }
        try {
          const deleted = await sshTransferJournalCleanup(recoveryId, recovery.record.partial);
          if (!deleted) {
            recordTransferRecovery(recovery.record, recoveryId, "delete_partial", "skipped", startedAt, "unsupported");
            return "unsupported";
          }
          set((s) => ({ recoveries: s.recoveries.filter((item) => item.record.recoveryId !== recoveryId) }));
          recordTransferRecovery(recovery.record, recoveryId, "delete_partial", "completed", startedAt);
          return "deleted";
        } catch (error) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery ? { ...item, error: recoveryError(error) } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "delete_partial", "failed", startedAt, "io");
          return "failed";
        }
      },
      restartRecovery: async (recoveryId) => {
        const recovery = get().recoveries.find((item) => item.record.recoveryId === recoveryId);
        if (!recovery) return "failed";
        const startedAt = Date.now();
        const resolved = currentReadySessionBinding(recovery.record.session);
        if (!resolved) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery
            ? { ...item, busy: false, error: "offline" } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "failed", startedAt, "disconnected");
          return "offline";
        }
        if (recovery.record.partial.kind === "remote") {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery
            ? { ...item, busy: false, error: "unsupported" } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "skipped", startedAt, "unsupported");
          return "unsupported";
        }
        set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery ? { ...item, busy: true, error: undefined } : item) }));
        try {
          if (!await sshTransferJournalCleanup(recoveryId, recovery.record.partial)) {
            set((s) => ({ recoveries: s.recoveries.map((item) => item.record.recoveryId === recoveryId
              ? { ...item, busy: false, error: "unsupported" } : item) }));
            recordTransferRecovery(recovery.record, recoveryId, "restart", "skipped", startedAt, "unsupported");
            return "unsupported";
          }
          // Prefer the newest authoritative lifecycle binding after cleanup.
          // If the session dropped in that narrow window, queueing the binding
          // verified above preserves a retryable transfer item; Rust still
          // rejects it fail-closed if it has become stale.
          const binding = currentReadySessionBinding(recovery.record.session) ?? resolved;
          const direction = recovery.record.direction === "upload" ? "upload" : "download";
          get().enqueue({
            binding, direction,
            source: recovery.record.source,
            destination: recovery.record.finalPath,
            conflict: "rename",
          });
          set((s) => ({ recoveries: s.recoveries.filter((item) => item.record.recoveryId !== recoveryId) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "scheduled", startedAt);
          return "queued";
        } catch (error) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item.record.recoveryId === recoveryId
            ? { ...item, busy: false, error: recoveryError(error) } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "failed", startedAt, "io");
          return "failed";
        }
      },
      resumeRecovery: async (recoveryId) => {
        const recovery = get().recoveries.find((item) => item.record.recoveryId === recoveryId);
        if (!recovery) return "failed";
        const startedAt = Date.now();
        const resolved = currentReadySessionBinding(recovery.record.session);
        if (!resolved) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery
            ? { ...item, busy: false, error: "offline" } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "failed", startedAt, "disconnected");
          return "offline";
        }
        if (!canResumeRecovery(recovery.record)) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery
            ? { ...item, busy: false, error: "unsupported" } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "skipped", startedAt, "unsupported");
          return "unsupported";
        }
        set((s) => ({ recoveries: s.recoveries.map((item) => item === recovery ? { ...item, busy: true, error: undefined } : item) }));
        try {
          await sshTransferRecoveryDismiss(recoveryId);
          const binding = currentReadySessionBinding(recovery.record.session) ?? resolved;
          const direction = recovery.record.direction === "upload" ? "upload" : "download";
          const overwrite = direction === "upload" && recovery.record.partial.path !== recovery.record.finalPath;
          get().enqueue({
            binding,
            direction,
            source: recovery.record.source,
            destination: recovery.record.finalPath,
            conflict: overwrite ? "replace" : "rename",
            resumeFrom: recovery.record.bytes,
            resumePartial: recovery.record.partial.path,
            createParents: direction === "download",
          });
          set((s) => ({ recoveries: s.recoveries.filter((item) => item.record.recoveryId !== recoveryId) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "scheduled", startedAt);
          return "queued";
        } catch (error) {
          set((s) => ({ recoveries: s.recoveries.map((item) => item.record.recoveryId === recoveryId
            ? { ...item, busy: false, error: recoveryError(error) } : item) }));
          recordTransferRecovery(recovery.record, recoveryId, "restart", "failed", startedAt, "io");
          return "failed";
        }
      },
      dismissRecovery: async (recoveryId) => {
        const recovery = get().recoveries.find((item) => item.record.recoveryId === recoveryId);
        const startedAt = Date.now();
        try {
          await sshTransferRecoveryDismiss(recoveryId);
          set((s) => ({ recoveries: s.recoveries.filter((item) => item.record.recoveryId !== recoveryId) }));
          if (recovery) recordTransferRecovery(recovery.record, recoveryId, "dismiss", "completed", startedAt);
        } catch (error) {
          if (recovery) recordTransferRecovery(recovery.record, recoveryId, "dismiss", "failed", startedAt, "io");
          throw error;
        }
      },
    };
  });
  return useStore;
}

export const useTransferStore = createTransferStore();
