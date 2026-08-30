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
import { recordFrontendPerf } from "@/modules/perf/benchmark-counters";

export type TransferConflict = "skip" | "replace" | "rename";
export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | "needsReconcile";
export interface TransferRequest {
  transferId?: string; batchId?: string; binding: SessionBindingV1; direction: TransferDirection;
  source: string; destination: string; conflict: TransferConflict;
  recoveryId?: string; createParents?: boolean;
}
export interface TransferItem extends Required<Omit<TransferRequest, "batchId" | "transferId" | "recoveryId" | "createParents">> {
  transferId: string; batchId?: string; attempt: number; status: TransferStatus;
  event?: SshTransferEvent; outcome?: SshTransferOutcome; error?: string; cancelRequested: boolean;
  recoveryId?: string; createParents?: boolean;
  rateSamples?: TransferRateSample[]; startedAt?: number;
}
export interface TransferRecoveryItem {
  record: TransferJournalRecord;
  observation?: "partialMatches" | "finalMatches" | "finalAndPartialMatch";
  busy: boolean;
  error?: "offline" | "identityMismatch" | "unsupported" | "failed";
}
export interface TransferAggregate {
  total: number; completed: number; running: number; queued: number; failed: number; cancelled: number; progress: number;
}
type Runner = (item: TransferItem, event: (value: SshTransferEvent) => void) => Promise<{ outcome: SshTransferOutcome }>;
export interface TransferState {
  readonly itemsById: ReadonlyMap<string, TransferItem>; readonly order: readonly string[]; readonly queuedIds: ReadonlySet<string>;
  readonly idsByBatch: ReadonlyMap<string, ReadonlySet<string>>; readonly idsBySession: ReadonlyMap<string, ReadonlySet<string>>;
  readonly aggregateByBatch: ReadonlyMap<string, TransferAggregate>; readonly aggregateBySession: ReadonlyMap<string, TransferAggregate>;
  revision: number; orderRevision: number;
  materializeItems(): TransferItem[];
  /** Explicit fixture/import boundary; product code must use enqueue. */
  replaceItemsForTest(items: readonly TransferItem[]): void;
  readonly testMetrics: { publications: number; pumpRuns: number; pumpCandidates: number };
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
    recoveryId: item.recoveryId,
    createParents: item.createParents,
  };
  return item.direction === "upload"
    ? sshTransferUpload(item.binding, item.transferId, item.attempt, item.source, item.destination, item.conflict === "replace", event, options)
    : sshTransferDownload(item.binding, item.transferId, item.attempt, item.source, item.destination, event, options);
};
const FINISHED_LIMIT = 200;
const UNRESOLVED_LIMIT = 200;
const active = (item: TransferItem) => item.status === "queued" || item.status === "running";
const contribution = (item: TransferItem) => ({
  completed: item.status === "completed" ? 1 : 0,
  running: item.status === "running" ? 1 : 0,
  queued: item.status === "queued" ? 1 : 0,
  failed: item.status === "failed" || item.status === "needsReconcile" ? 1 : 0,
  cancelled: item.status === "cancelled" ? 1 : 0,
  progress: ["completed", "failed", "cancelled", "needsReconcile"].includes(item.status) ? 1
    : item.status === "running" && (item.event?.totalBytes ?? 0) > 0
      ? Math.min(1, (item.event?.bytesTransferred ?? 0) / item.event!.totalBytes!) : 0,
});
const emptyAggregate = (): TransferAggregate => ({ total: 0, completed: 0, running: 0, queued: 0, failed: 0, cancelled: 0, progress: 0 });
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
  let runningGlobal = 0;
  const runningByBinding = new Map<string, number>();
  const runningIds = new Set<string>();
  const pendingRetries = new Set<string>();
  const itemsById = new Map<string, TransferItem>();
  const queuedIds = new Set<string>();
  const idsByBatch = new Map<string, Set<string>>();
  const idsBySession = new Map<string, Set<string>>();
  const aggregateByBatch = new Map<string, TransferAggregate>();
  const aggregateBySession = new Map<string, TransferAggregate>();
  const resolvedHistory: string[] = [];
  const unresolvedHistory: string[] = [];
  const metrics = { publications: 0, pumpRuns: 0, pumpCandidates: 0 };
  const useStore = create<TransferState>((set, get) => {
    const bindingKey = (binding: SessionBindingV1) => `${binding.logicalSessionId}\0${binding.physicalPtyId}\0${binding.transportGeneration}`;
    const publish = (order?: string[]) => {
      metrics.publications++; recordFrontendPerf("transferStoreWrites");
      set((state) => ({ ...(order ? { order, orderRevision: state.orderRevision + 1 } : {}), revision: state.revision + 1 }));
    };
    const adjustAggregate = (map: Map<string, TransferAggregate>, key: string, previous?: TransferItem, next?: TransferItem) => {
      const value = { ...(map.get(key) ?? emptyAggregate()) };
      value.total += (next ? 1 : 0) - (previous ? 1 : 0);
      const before = previous ? contribution(previous) : undefined; const after = next ? contribution(next) : undefined;
      for (const field of ["completed", "running", "queued", "failed", "cancelled", "progress"] as const) value[field] += (after?.[field] ?? 0) - (before?.[field] ?? 0);
      if (value.total === 0) map.delete(key); else map.set(key, value);
    };
    const indexItem = (item: TransferItem) => {
      itemsById.set(item.transferId, item);
      if (item.status === "queued") queuedIds.add(item.transferId);
      if (item.status === "running") { const key = bindingKey(item.binding); runningIds.add(item.transferId); runningGlobal++; runningByBinding.set(key, (runningByBinding.get(key) ?? 0) + 1); }
      if (item.batchId) { const ids = idsByBatch.get(item.batchId) ?? new Set<string>(); ids.add(item.transferId); idsByBatch.set(item.batchId, ids); adjustAggregate(aggregateByBatch, item.batchId, undefined, item); }
      const session = item.binding.logicalSessionId; const ids = idsBySession.get(session) ?? new Set<string>(); ids.add(item.transferId); idsBySession.set(session, ids); adjustAggregate(aggregateBySession, session, undefined, item);
    };
    const removeItem = (transferId: string, order: string[]) => {
      const item = itemsById.get(transferId); if (!item) return;
      itemsById.delete(transferId); queuedIds.delete(transferId); runningIds.delete(transferId);
      if (item.batchId) { idsByBatch.get(item.batchId)?.delete(transferId); adjustAggregate(aggregateByBatch, item.batchId, item, undefined); }
      idsBySession.get(item.binding.logicalSessionId)?.delete(transferId); adjustAggregate(aggregateBySession, item.binding.logicalSessionId, item, undefined);
      const index = order.indexOf(transferId); if (index >= 0) order.splice(index, 1);
      let historyIndex = resolvedHistory.indexOf(transferId); if (historyIndex >= 0) resolvedHistory.splice(historyIndex, 1);
      historyIndex = unresolvedHistory.indexOf(transferId); if (historyIndex >= 0) unresolvedHistory.splice(historyIndex, 1);
    };
    const boundTerminal = (item: TransferItem, order: string[]) => {
      const queue = item.status === "needsReconcile" ? unresolvedHistory : resolvedHistory;
      queue.push(item.transferId); const limit = item.status === "needsReconcile" ? UNRESOLVED_LIMIT : FINISHED_LIMIT;
      while (queue.length > limit) removeItem(queue.shift()!, order);
    };
    const patchItem = (transferId: string, expectedAttempt: number, fn: (item: TransferItem) => TransferItem | undefined) => {
      const previous = itemsById.get(transferId);
      if (!previous || previous.attempt !== expectedAttempt) return false;
      const next = fn(previous); if (!next || next === previous) return false;
      itemsById.set(transferId, next);
      if (previous.status === "queued") queuedIds.delete(transferId); if (next.status === "queued") queuedIds.add(transferId);
      if (previous.status !== next.status) {
        if (previous.status === "running") { const key = bindingKey(previous.binding); runningIds.delete(transferId); runningGlobal--; runningByBinding.set(key, (runningByBinding.get(key) ?? 1) - 1); }
        if (next.status === "running") { const key = bindingKey(next.binding); runningIds.add(transferId); runningGlobal++; runningByBinding.set(key, (runningByBinding.get(key) ?? 0) + 1); }
      }
      if (next.batchId) adjustAggregate(aggregateByBatch, next.batchId, previous, next);
      adjustAggregate(aggregateBySession, next.binding.logicalSessionId, previous, next);
      const previousHistory = previous.status === "needsReconcile" ? unresolvedHistory : resolvedHistory;
      const nextHistory = next.status === "needsReconcile" ? unresolvedHistory : resolvedHistory;
      const historyTransition = (!active(next) && (active(previous) || previousHistory !== nextHistory));
      if (active(next) && !active(previous)) {
        const historyIndex = previousHistory.indexOf(transferId);
        if (historyIndex >= 0) previousHistory.splice(historyIndex, 1);
      }
      if (historyTransition) {
        const historyIndex = previousHistory.indexOf(transferId);
        if (historyIndex >= 0) previousHistory.splice(historyIndex, 1);
        const order = [...get().order];
        boundTerminal(next, order);
        publish(order.length !== get().order.length ? order : undefined);
      } else publish();
      return true;
    };
    const pump = () => {
      if (pumping) return; pumping = true;
      queueMicrotask(() => {
        pumping = false;
        metrics.pumpRuns++;
        for (const transferId of queuedIds) {
          metrics.pumpCandidates++;
          const item = itemsById.get(transferId); if (!item) continue;
          if (runningGlobal >= 4) break;
          if (item.status !== "queued" || item.cancelRequested) continue;
          const count = runningByBinding.get(bindingKey(item.binding)) ?? 0;
          if (count >= 2) continue;
          patchItem(item.transferId, item.attempt, (x) => x.status === "queued" ? { ...x, status: "running", startedAt: Date.now(), rateSamples: [] } : undefined);
          const startedAt = Date.now();
          void run(item, (event) => patchItem(item.transferId, item.attempt, (x) => {
            if (x.status !== "running") return undefined;
            const nextEvent = acceptSshTransferEvent(x.event, event);
            if (nextEvent === x.event) return undefined;
            return {
              ...x,
              event: nextEvent,
              rateSamples: pushRateSample(x.rateSamples ?? [], { at: Date.now(), bytes: nextEvent?.bytesTransferred ?? 0 }),
            };
          }))
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
              const status = outcome.status === "completed" ? "completed" : outcome.status === "cancelled" ? "cancelled" : outcome.status === "outcomeUnknown" ? "needsReconcile" : "failed";
              patchItem(item.transferId, item.attempt, (x) => x.status === "running" ? { ...x, outcome, status } : undefined);
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
              if (item.recoveryId || outcome.status === "outcomeUnknown" || ("residuePath" in outcome && outcome.residuePath)) void get().loadJournal();
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
              patchItem(item.transferId, item.attempt, (x) => x.status === "running" ? { ...x, status: "failed", error: error instanceof Error ? error.message : String(error) } : undefined);
              if (item.recoveryId) void get().loadJournal();
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
      indexItem(item); const order = [...get().order, transferId]; if (!active(item)) boundTerminal(item, order); publish(order); pump(); return transferId;
    };
    return {
      itemsById, order: [], queuedIds, idsByBatch, idsBySession, aggregateByBatch, aggregateBySession, testMetrics: metrics,
      revision: 0, orderRevision: 0, recoveries: [], journalLoaded: false, enqueue,
      materializeItems: () => get().order.flatMap((transferId) => { const item = itemsById.get(transferId); return item ? [item] : []; }),
      replaceItemsForTest: (items) => {
        itemsById.clear(); queuedIds.clear(); runningIds.clear(); idsByBatch.clear(); idsBySession.clear(); aggregateByBatch.clear(); aggregateBySession.clear(); runningByBinding.clear(); resolvedHistory.length = 0; unresolvedHistory.length = 0; runningGlobal = 0;
        const order: string[] = []; for (const item of items) { indexItem(item); order.push(item.transferId); if (!active(item)) (item.status === "needsReconcile" ? unresolvedHistory : resolvedHistory).push(item.transferId); }
        publish(order);
      },
      enqueueBatch: (requests, batchId = id()) => {
        const transferIds: string[] = [];
        const additions = requests.map((request) => {
          const transferId = request.transferId ?? id(); transferIds.push(transferId);
          recordLocalUsageEvent({
            event: "ssh.transfer.queued", sessionId: request.binding.logicalSessionId, correlationId: transferId,
            success: request.conflict !== "skip", outcome: request.conflict === "skip" ? "skipped" : "scheduled",
            attributes: { direction: request.direction, operation: request.direction, attempt: "1" },
          });
          return { ...request, batchId, transferId, attempt: 1, status: request.conflict === "skip" ? "cancelled" as const : "queued" as const, cancelRequested: false };
        });
        const order = [...get().order]; for (const item of additions) { indexItem(item); order.push(item.transferId); if (!active(item)) boundTerminal(item, order); }
        publish(order); pump(); return transferIds;
      },
      cancel: async (transferId) => {
        const item = itemsById.get(transferId); if (!item) return;
        patchItem(transferId, item.attempt, (x) => active(x) ? { ...x, cancelRequested: true, status: x.status === "queued" ? "cancelled" : x.status } : undefined);
        if (item.status === "running") await sshTransferCancel(item.transferId, item.attempt);
        else if (item.status === "queued" && item.recoveryId) await get().loadJournal();
        pump();
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
        await Promise.all([...idsByBatch.get(batchId) ?? []].map((transferId) => itemsById.get(transferId)).filter((item): item is TransferItem => !!item && active(item)).map((item) => get().cancel(item.transferId)));
      },
      cancelAll: async (logicalSessionId) => {
        const ids = logicalSessionId ? [...idsBySession.get(logicalSessionId) ?? []] : [...queuedIds, ...runningIds];
        await Promise.all(ids.map((transferId) => get().cancel(transferId)));
      },
      retry: async (transferId, confirmFresh) => {
        const item = itemsById.get(transferId);
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
          const stillRetryable = () => { const candidate = itemsById.get(transferId); return candidate?.attempt === originalAttempt && (candidate.status === "failed" || candidate.status === "cancelled") ? candidate : undefined; };
          if (!stillRetryable()) return "notRetryable";
          const latest = currentReadySessionBinding(item.binding.logicalSessionId);
          if (!latest) return "offline";
          if (latest.physicalPtyId !== binding.physicalPtyId || latest.transportGeneration !== binding.transportGeneration) {
            if (!(await confirmFresh?.("replacement")) || !stillRetryable()) return "replacementDeclined";
            const confirmed = currentReadySessionBinding(item.binding.logicalSessionId);
            if (!confirmed) return "offline";
            binding = confirmed;
          }
          patchItem(transferId, originalAttempt, (x) => x.status === "failed" || x.status === "cancelled"
            ? { ...x, binding, attempt: x.attempt + 1, status: "queued", outcome: undefined, error: undefined, event: undefined, cancelRequested: false } : undefined);
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
      clearFinished: (logicalSessionId) => {
        const candidates = logicalSessionId ? [...idsBySession.get(logicalSessionId) ?? []] : [...resolvedHistory]; const order = [...get().order];
        for (const transferId of candidates) { const item = itemsById.get(transferId); if (item && !active(item) && item.status !== "needsReconcile") removeItem(transferId, order); }
        publish(order);
      },
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
            patchItem(recovery.record.transferId, recovery.record.attempt, (item) => item.status === "needsReconcile" ? {
              ...item, status: "completed", outcome: { status: "completed", bytesTransferred: result.record.bytes }, error: undefined,
            } : undefined);
            set((s) => ({ recoveries: s.recoveries.filter((item) => item.record.recoveryId !== recoveryId) }));
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
          const binding = currentReadySessionBinding(recovery.record.session) ?? resolved;
          const direction = recovery.record.direction === "upload" ? "upload" : "download";
          const overwrite = direction === "upload" && (recovery.record.overwrite
            ?? recovery.record.partial.path !== recovery.record.finalPath);
          get().enqueue({
            binding,
            direction,
            source: recovery.record.source,
            destination: recovery.record.finalPath,
            conflict: overwrite ? "replace" : "rename",
            recoveryId,
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
