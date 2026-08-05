import { useEffect, useMemo, useRef, useState } from "react";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import { useT } from "@/modules/i18n";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { InspectorScopedPanelProps } from "./inspector-scope";

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
  return <section aria-label={t("transfer.center.aria_label")} data-inspector-scope={inspectorScope?.key}>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    <header>
      <strong>{global ? t("transfer.center.global_title") : t("transfer.center.session_title")}</strong>
      {logicalSessionId && <button type="button" onClick={() => setGlobal((value) => !value)}>{global ? t("transfer.center.session_view") : t("transfer.center.global_view")}</button>}
      <button type="button" onClick={() => void confirmAction(global ? t("transfer.confirm.cancel_all_global") : t("transfer.confirm.cancel_all_session")).then((approved) => { if (approved) return cancelAll(global ? undefined : logicalSessionId); })}>{global ? t("transfer.center.cancel_all_global") : t("transfer.center.cancel_all_session")}</button>
      <button type="button" onClick={() => void confirmAction(t("transfer.confirm.clear_finished")).then((approved) => { if (approved) clearFinished(global ? undefined : logicalSessionId); })}>{t("transfer.center.clear_finished")}</button>
    </header>
    <ul>{visibleItems.map((item) => <li key={`${item.transferId}-${item.attempt}`}>
      <span>{t(`transfer.direction.${item.direction}`)} · {item.binding.logicalSessionId} / PTY {item.binding.physicalPtyId} · {item.source} → {item.destination} · {t("transfer.attempt", { attempt: item.attempt })} · {t(`transfer.status.${item.status}`)}</span>
      {(item.status === "queued" || item.status === "running") && <button type="button" aria-label={t("transfer.cancel_item", { file: item.source })} onClick={() => void cancel(item.transferId)}>{t("transfer.cancel")}</button>}
      {(item.status === "failed" || item.status === "cancelled") && <button type="button" aria-label={t("transfer.retry_item", { file: item.source })} onClick={() => void retry(item.transferId, (reason) => confirm(t(reason === "replace" ? "transfer.retry.replace_confirm" : "transfer.retry.replacement_confirm"), { kind: "warning" })).then((result) => { if (result === "offline") setAnnouncement(t("transfer.retry.offline")); })}>{t("transfer.retry_fresh")}</button>}
      {item.outcome && "residuePath" in item.outcome && item.outcome.residuePath && <div role="alert">{t("transfer.residue", { path: item.outcome.residuePath })}</div>}
      {item.event?.totalBytes != null && <progress aria-label={t("transfer.progress", { file: item.source })} max={item.event.totalBytes || 1} value={item.event.bytesTransferred} />}
    </li>)}</ul>
    {visibleRecoveries.length > 0 && <section aria-label={t("transfer.recovery.title")}>
      <h3>{t("transfer.recovery.title")}</h3>
      <ul>{visibleRecoveries.map(({ record, observation, busy, error }) => <li key={record.recoveryId}>
        <span>{record.endpoint} · {record.source} → {record.finalPath} · {t("transfer.attempt", { attempt: record.attempt })} · {record.needsReconcile ? t("transfer.status.needsReconcile") : t("transfer.recovery.paused")}</span>
        {observation && <span> · {t(`transfer.recovery.observation.${observation}`)}</span>}
        {error && <div role="alert">{t(`transfer.recovery.error.${error}`)}</div>}
        <button type="button" disabled={busy} onClick={() => void reconcileRecovery(record.recoveryId).then((result) => setAnnouncement(t(`transfer.recovery.reconcile.${result}`)))}>{t("transfer.recovery.reconcile")}</button>
        <button type="button" disabled title={t("transfer.recovery.resume_unavailable")}>{t("transfer.recovery.resume")}</button>
        <button type="button" disabled={busy || record.partial.kind === "remote"} title={record.partial.kind === "remote" ? t("transfer.recovery.remote_cleanup_unavailable") : undefined} onClick={() => void confirmAction(t("transfer.confirm.restart")).then((approved) => { if (approved) return restartRecovery(record.recoveryId).then((result) => setAnnouncement(t(`transfer.recovery.restart.${result}`))); })}>{t("transfer.recovery.restart")}</button>
        <button type="button" disabled={busy || record.partial.kind === "remote"} title={record.partial.kind === "remote" ? t("transfer.recovery.remote_cleanup_unavailable") : undefined} onClick={() => void confirmAction(t("transfer.confirm.delete_partial")).then((approved) => { if (approved) return deleteRecoveryPartial(record.recoveryId); })}>{t("transfer.recovery.delete_partial")}</button>
        <button type="button" disabled={busy} onClick={() => void confirmAction(t("transfer.confirm.dismiss")).then((approved) => { if (approved) return dismissRecovery(record.recoveryId); })}>{t("transfer.recovery.dismiss")}</button>
      </li>)}</ul>
    </section>}
  </section>;
}
