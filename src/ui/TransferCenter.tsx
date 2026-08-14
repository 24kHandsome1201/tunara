import { useEffect, useMemo, useRef, useState } from "react";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { useT } from "@/modules/i18n";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { InspectorScopedPanelProps } from "./inspector-scope";
import { PanelActionButton, PanelEmptyState, PanelToolbar } from "./shared";

export function TransferCenter({ inspectorScope }: Partial<InspectorScopedPanelProps> = {}) {
  const t = useT();
  const items = useTransferStore((state) => state.items);
  const cancel = useTransferStore((state) => state.cancel);
  const cancelAll = useTransferStore((state) => state.cancelAll);
  const retry = useTransferStore((state) => state.retry);
  const clearFinished = useTransferStore((state) => state.clearFinished);
  const recoveries = useTransferStore((state) => state.recoveries);
  const reconcileRecovery = useTransferStore((state) => state.reconcileRecovery);
  const deleteRecoveryPartial = useTransferStore((state) => state.deleteRecoveryPartial);
  const restartRecovery = useTransferStore((state) => state.restartRecovery);
  const dismissRecovery = useTransferStore((state) => state.dismissRecovery);
  const logicalSessionId = inspectorScope?.logicalSessionId;
  const [global, setGlobal] = useState(!logicalSessionId);
  const visibleItems = useMemo(() => global || !logicalSessionId ? items : items.filter((item) => item.binding.logicalSessionId === logicalSessionId), [global, items, logicalSessionId]);
  const visibleRecoveries = useMemo(() => global || !logicalSessionId ? recoveries : recoveries.filter((item) => item.record.session === logicalSessionId), [global, recoveries, logicalSessionId]);
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
  const cardStyle = { padding: 9, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexDirection: "column", gap: 7 } as const;
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
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
          {visibleItems.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {visibleItems.map((item) => (
                <li key={`${item.transferId}-${item.attempt}`} style={cardStyle}>
                  <span style={{ color: "var(--c-text-3)", fontSize: "var(--fs-meta)", overflowWrap: "anywhere" }}>
                    {t(`transfer.direction.${item.direction}`)} · {item.binding.logicalSessionId} / PTY {item.binding.physicalPtyId} · {item.source} → {item.destination} · {t("transfer.attempt", { attempt: item.attempt })} · {t(`transfer.status.${item.status}`)}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {(item.status === "queued" || item.status === "running") && <PanelActionButton aria-label={t("transfer.cancel_item", { file: item.source })} onClick={() => void cancel(item.transferId)}>{t("transfer.cancel")}</PanelActionButton>}
                    {(item.status === "failed" || item.status === "cancelled") && <PanelActionButton aria-label={t("transfer.retry_item", { file: item.source })} onClick={() => void retry(item.transferId, (reason) => confirm(t(reason === "replace" ? "transfer.retry.replace_confirm" : "transfer.retry.replacement_confirm"), { kind: "warning" })).then((result) => { if (result === "offline") setAnnouncement(t("transfer.retry.offline")); })}>{t("transfer.retry_fresh")}</PanelActionButton>}
                  </div>
                  {item.outcome && "residuePath" in item.outcome && item.outcome.residuePath && <div role="alert" style={{ color: "var(--c-warning-text)", fontSize: "var(--fs-meta)" }}>{t("transfer.residue", { path: item.outcome.residuePath })}</div>}
                  {item.event?.totalBytes != null && <progress style={{ width: "100%" }} aria-label={t("transfer.progress", { file: item.source })} max={item.event.totalBytes || 1} value={item.event.bytesTransferred} />}
                </li>
              ))}
            </ul>
          )}
          {visibleRecoveries.length > 0 && (
            <section aria-label={t("transfer.recovery.title")} style={{ marginTop: visibleItems.length > 0 ? 14 : 0 }}>
              <h3 style={{ margin: "0 0 7px", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)" }}>{t("transfer.recovery.title")}</h3>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {visibleRecoveries.map(({ record, observation, busy, error }) => (
                  <li key={record.recoveryId} style={cardStyle}>
                    <span style={{ color: "var(--c-text-3)", fontSize: "var(--fs-meta)", overflowWrap: "anywhere" }}>
                      {record.endpoint} · {record.source} → {record.finalPath} · {t("transfer.attempt", { attempt: record.attempt })} · {record.needsReconcile ? t("transfer.status.needsReconcile") : t("transfer.recovery.paused")}
                      {observation && <> · {t(`transfer.recovery.observation.${observation}`)}</>}
                    </span>
                    {error && <div role="alert" style={{ color: "var(--c-warning-text)", fontSize: "var(--fs-meta)" }}>{t(`transfer.recovery.error.${error}`)}</div>}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <PanelActionButton disabled={busy} onClick={() => void reconcileRecovery(record.recoveryId).then((result) => setAnnouncement(t(`transfer.recovery.reconcile.${result}`)))}>{t("transfer.recovery.reconcile")}</PanelActionButton>
                      <PanelActionButton disabled title={t("transfer.recovery.resume_unavailable")}>{t("transfer.recovery.resume")}</PanelActionButton>
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
