import { useEffect, useMemo, useRef, useState } from "react";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { useT } from "@/modules/i18n";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { InspectorScopedPanelProps } from "./inspector-scope";
import { PanelActionButton, PanelEmptyState, PanelToolbar } from "./shared";
import { formatTransferEta, formatTransferRate, transferEta, transferRate } from "@/modules/ssh/transfer-rate";
import { canResumeRecovery } from "@/modules/ssh/transfer-resume";

export function TransferCenter({ inspectorScope }: Partial<InspectorScopedPanelProps> = {}) {
  const t = useT();
  const items = useTransferStore((state) => state.items);
  const cancel = useTransferStore((state) => state.cancel);
  const cancelBatch = useTransferStore((state) => state.cancelBatch);
  const cancelAll = useTransferStore((state) => state.cancelAll);
  const retry = useTransferStore((state) => state.retry);
  const clearFinished = useTransferStore((state) => state.clearFinished);
  const recoveries = useTransferStore((state) => state.recoveries);
  const reconcileRecovery = useTransferStore((state) => state.reconcileRecovery);
  const deleteRecoveryPartial = useTransferStore((state) => state.deleteRecoveryPartial);
  const restartRecovery = useTransferStore((state) => state.restartRecovery);
  const resumeRecovery = useTransferStore((state) => state.resumeRecovery);
  const dismissRecovery = useTransferStore((state) => state.dismissRecovery);
  const logicalSessionId = inspectorScope?.logicalSessionId;
  const [global, setGlobal] = useState(!logicalSessionId);
  const visibleItems = useMemo(() => global || !logicalSessionId ? items : items.filter((item) => item.binding.logicalSessionId === logicalSessionId), [global, items, logicalSessionId]);
  const visibleRecoveries = useMemo(() => global || !logicalSessionId ? recoveries : recoveries.filter((item) => item.record.session === logicalSessionId), [global, recoveries, logicalSessionId]);
  const visibleBatches = useMemo(() => {
    const grouped = new Map<string, typeof visibleItems>();
    for (const item of visibleItems) {
      if (!item.batchId) continue;
      grouped.set(item.batchId, [...(grouped.get(item.batchId) ?? []), item]);
    }
    return [...grouped.entries()]
      .filter(([, batchItems]) => batchItems.length > 1)
      .map(([batchId, batchItems]) => {
        const completed = batchItems.filter((item) => item.status === "completed").length;
        const running = batchItems.filter((item) => item.status === "running").length;
        const queued = batchItems.filter((item) => item.status === "queued").length;
        const failed = batchItems.filter((item) => item.status === "failed" || item.status === "needsReconcile").length;
        const cancelled = batchItems.filter((item) => item.status === "cancelled").length;
        const progress = batchItems.reduce((total, item) => {
          if (["completed", "failed", "cancelled", "needsReconcile"].includes(item.status)) return total + 1;
          const bytes = item.event?.bytesTransferred ?? 0;
          const itemTotal = item.event?.totalBytes ?? 0;
          return total + (itemTotal > 0 ? Math.min(1, bytes / itemTotal) : 0);
        }, 0);
        return { batchId, total: batchItems.length, completed, running, queued, failed, cancelled, progress };
      });
  }, [visibleItems]);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(new Map<string, { status: string; bucket: number; at: number }>());
  useEffect(() => {
    const now = Date.now();
    const keys = new Set(visibleItems.map((item) => `${item.transferId}:${item.attempt}`));
    for (const key of announced.current.keys()) if (!keys.has(key)) announced.current.delete(key);
    for (const item of visibleItems) {
      const key = `${item.transferId}:${item.attempt}`;
      const previous = announced.current.get(key);
      const total = item.event?.totalBytes ?? 0;
      const percent = total > 0 ? Math.min(100, Math.round((item.event?.bytesTransferred ?? 0) / total * 100)) : 0;
      const bucket = Math.floor(percent / 10);
      if (!previous) {
        setAnnouncement(t("transfer.announcement.started", { file: item.source }));
      } else if (previous.status !== item.status && ["completed", "cancelled", "failed", "needsReconcile"].includes(item.status)) {
        setAnnouncement(t(`transfer.announcement.${item.status}`, { file: item.source }));
      } else if (item.status === "running" && (bucket > previous.bucket || now - previous.at >= 2_000)) {
        setAnnouncement(t("transfer.announcement.progress", { file: item.source, percent }));
      } else {
        continue;
      }
      announced.current.set(key, { status: item.status, bucket, at: now });
    }
  }, [visibleItems, t]);
  const confirmAction = (message: string) => confirm(message, { kind: "warning" });
  const hasAnyContent = items.length > 0 || recoveries.length > 0;
  const hasVisibleContent = visibleItems.length > 0 || visibleRecoveries.length > 0;
  const canCancel = visibleItems.some((item) => item.status === "queued" || item.status === "running");
  const canClear = visibleItems.some((item) => ["completed", "cancelled", "failed"].includes(item.status));
  return (
    <section aria-label={t("transfer.center.aria_label")} data-inspector-scope={inspectorScope?.key} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      <PanelToolbar title={global ? t("transfer.center.global_title") : t("transfer.center.session_title")}>
        {logicalSessionId && (global || hasAnyContent) && (
          <PanelActionButton onClick={() => setGlobal((value) => !value)}>
            {global ? t("transfer.center.session_view") : t("transfer.center.global_view")}
          </PanelActionButton>
        )}
        {canCancel && (
          <PanelActionButton onClick={() => void confirmAction(global ? t("transfer.confirm.cancel_all_global") : t("transfer.confirm.cancel_all_session")).then((approved) => { if (approved) return cancelAll(global ? undefined : logicalSessionId); })}>
            {global ? t("transfer.center.cancel_all_global") : t("transfer.center.cancel_all_session")}
          </PanelActionButton>
        )}
        {canClear && (
          <PanelActionButton onClick={() => void confirmAction(t("transfer.confirm.clear_finished")).then((approved) => { if (approved) clearFinished(global ? undefined : logicalSessionId); })}>
            {t("transfer.center.clear_finished")}
          </PanelActionButton>
        )}
      </PanelToolbar>

      {!hasVisibleContent ? (
        <PanelEmptyState
          label={t("transfer.center.empty")}
          sublabel={t(global ? "transfer.center.empty_global" : "transfer.center.empty_session")}
        />
      ) : (
        <div className="transfer-center-content">
          {visibleBatches.length > 0 && (
            <section aria-label={t("transfer.batch.title")} className="transfer-section">
              <h3 className="transfer-section-title">{t("transfer.batch.title")}</h3>
              <ul className="transfer-list">
                {visibleBatches.map((batch) => (
                  <li key={batch.batchId} className="transfer-card transfer-card--batch">
                    <span className="transfer-card-summary">
                      {t("transfer.batch.summary", batch)}
                    </span>
                    {(batch.running > 0 || batch.queued > 0) && (
                      <PanelActionButton
                        aria-label={t("transfer.batch.cancel_label", { count: batch.total })}
                        onClick={() => void confirmAction(t("transfer.confirm.cancel_batch", { count: batch.total })).then((approved) => { if (approved) return cancelBatch(batch.batchId); })}
                      >
                        {t("transfer.batch.cancel")}
                      </PanelActionButton>
                    )}
                    <progress
                      className="ui-progress"
                      style={{ width: "100%" }}
                      aria-label={t("transfer.batch.progress", { count: batch.total })}
                      max={batch.total}
                      value={batch.progress}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {visibleItems.length > 0 && (
            <ul className="transfer-list">
              {visibleItems.map((item) => (
                <li key={`${item.transferId}-${item.attempt}`} className="transfer-card" data-status={item.status}>
                  <div className="transfer-card-heading">
                    <strong title={item.source}>{item.source.split(/[\\/]/).pop() || item.source}</strong>
                    <span className="transfer-status" data-status={item.status}>{t(`transfer.status.${item.status}`)}</span>
                  </div>
                  <div className="transfer-path" title={`${item.source} → ${item.destination}`}>
                    <span>{item.source}</span><span aria-hidden="true">→</span><span>{item.destination}</span>
                  </div>
                  <div className="transfer-meta">
                    {t(`transfer.direction.${item.direction}`)} · {item.binding.logicalSessionId} / PTY {item.binding.physicalPtyId} · {t("transfer.attempt", { attempt: item.attempt })}
                    {item.status === "running" && (() => {
                      const snapshot = transferRate(item.rateSamples ?? []);
                      if (!snapshot || snapshot.bytesPerSec <= 0) return null;
                      const eta = formatTransferEta(transferEta(item.event?.bytesTransferred ?? 0, item.event?.totalBytes, snapshot.bytesPerSec));
                      return <> · {eta ? t("transfer.rate", { rate: formatTransferRate(snapshot.bytesPerSec), eta }) : t("transfer.rate_only", { rate: formatTransferRate(snapshot.bytesPerSec) })}</>;
                    })()}
                  </div>
                  <div className="transfer-card-actions">
                    {(item.status === "queued" || item.status === "running") && <PanelActionButton aria-label={t("transfer.cancel_item", { file: item.source })} onClick={() => void cancel(item.transferId)}>{t("transfer.cancel")}</PanelActionButton>}
                    {(item.status === "failed" || item.status === "cancelled") && <PanelActionButton aria-label={t("transfer.retry_item", { file: item.source })} onClick={() => void retry(item.transferId, (reason) => confirm(t(reason === "replace" ? "transfer.retry.replace_confirm" : "transfer.retry.replacement_confirm"), { kind: "warning" })).then((result) => { if (result === "offline") setAnnouncement(t("transfer.retry.offline")); })}>{t("transfer.retry_fresh")}</PanelActionButton>}
                  </div>
                  {item.outcome && "residuePath" in item.outcome && item.outcome.residuePath && <div role="alert" className="transfer-warning">{t("transfer.residue", { path: item.outcome.residuePath })}</div>}
                  {item.event?.totalBytes != null && <progress className="ui-progress" style={{ width: "100%" }} aria-label={t("transfer.progress", { file: item.source })} max={item.event.totalBytes || 1} value={item.event.bytesTransferred} />}
                </li>
              ))}
            </ul>
          )}
          {visibleRecoveries.length > 0 && (
            <section aria-label={t("transfer.recovery.title")} className="transfer-section" style={{ marginTop: visibleItems.length > 0 ? 14 : 0 }}>
              <h3 className="transfer-section-title">{t("transfer.recovery.title")}</h3>
              <ul className="transfer-list">
                {visibleRecoveries.map(({ record, observation, busy, error }) => (
                  <li key={record.recoveryId} className="transfer-card" data-status="needsReconcile">
                    <span className="transfer-card-summary">
                      {record.endpoint} · {record.source} → {record.finalPath} · {t("transfer.attempt", { attempt: record.attempt })} · {record.needsReconcile ? t("transfer.status.needsReconcile") : t("transfer.recovery.paused")}
                      {observation && <> · {t(`transfer.recovery.observation.${observation}`)}</>}
                    </span>
                    {error && <div role="alert" className="transfer-warning">{t(`transfer.recovery.error.${error}`)}</div>}
                    <div className="transfer-card-actions">
                      <PanelActionButton disabled={busy} onClick={() => void reconcileRecovery(record.recoveryId).then((result) => setAnnouncement(t(`transfer.recovery.reconcile.${result}`)))}>{t("transfer.recovery.reconcile")}</PanelActionButton>
                      <PanelActionButton disabled={busy || !canResumeRecovery(record)} title={canResumeRecovery(record) ? undefined : t("transfer.recovery.resume_unavailable")} onClick={() => void resumeRecovery(record.recoveryId).then((result) => setAnnouncement(t(`transfer.recovery.resume.${result}`)))}>{t("transfer.recovery.resume")}</PanelActionButton>
                      <PanelActionButton disabled={busy || record.partial.kind === "remote"} title={record.partial.kind === "remote" ? t("transfer.recovery.remote_cleanup_unavailable") : undefined} onClick={() => void confirmAction(t("transfer.confirm.restart")).then((approved) => { if (approved) return restartRecovery(record.recoveryId).then((result) => setAnnouncement(t(`transfer.recovery.restart.${result}`))); })}>{t("transfer.recovery.restart")}</PanelActionButton>
                      <PanelActionButton disabled={busy || record.partial.kind === "remote"} title={record.partial.kind === "remote" ? t("transfer.recovery.remote_cleanup_unavailable") : undefined} onClick={() => void confirmAction(t("transfer.confirm.delete_partial")).then((approved) => { if (approved) return deleteRecoveryPartial(record.recoveryId); })}>{t("transfer.recovery.delete_partial")}</PanelActionButton>
                      <PanelActionButton disabled={busy} onClick={() => void confirmAction(t("transfer.confirm.dismiss")).then((approved) => { if (approved) return dismissRecovery(record.recoveryId); })}>{t("transfer.recovery.dismiss")}</PanelActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
