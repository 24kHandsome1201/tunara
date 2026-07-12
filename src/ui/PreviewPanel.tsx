import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "./types";
import { useT } from "@/modules/i18n";
import { previewBlockReason, previewClose, previewOpen, previewRefresh } from "@/modules/preview/preview-window";
import type { PreviewSource } from "@/modules/preview/preview-source";

function SourceCard({ source }: { source: PreviewSource }) {
  const t = useT();
  const blocked = previewBlockReason(source);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (action: () => Promise<unknown>, nextOpen = open) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      setOpen(nextOpen);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value: string) => (
    <div style={{ display: "grid", gridTemplateColumns: "68px minmax(0, 1fr)", gap: 6, minWidth: 0 }}>
      <span style={{ color: "var(--c-text-5)" }}>{label}</span>
      <span title={value} style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );

  return (
    <section style={{ padding: 10, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 650, color: "var(--c-text-primary)" }}>{t("inspector.preview.source")}</span>
        <span style={{ marginLeft: "auto", color: blocked ? "var(--c-warning)" : "var(--c-success)", fontSize: "var(--fs-meta)" }}>
          {blocked ? t(`inspector.preview.blocked.${blocked}`) : t("inspector.preview.eligible")}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "var(--fs-meta)", color: "var(--c-text-3)", minWidth: 0 }}>
        {row(t("inspector.preview.repository"), source.repositoryId)}
        {row(t("inspector.preview.worktree"), source.worktreeId)}
        {row(t("inspector.preview.session"), source.sessionId)}
        {row(t("inspector.preview.terminal"), source.terminalId)}
        {row("URL", source.sourceUrl)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button disabled={busy || !!blocked} onClick={() => void run(() => previewOpen(source), true)}>{open ? t("inspector.preview.focus") : t("inspector.preview.open")}</button>
        <button disabled={busy || !!blocked || !open} onClick={() => void run(() => previewRefresh(source))}>{t("inspector.preview.refresh")}</button>
        <button disabled={busy || !!blocked || !open} onClick={() => void run(() => previewClose(source), false)}>{t("inspector.preview.close")}</button>
        <button disabled={busy} onClick={() => void run(() => openUrl(source.sourceUrl))}>{t("inspector.preview.external")}</button>
      </div>
      {error && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-danger)" }}>{error}</div>}
    </section>
  );
}

export function PreviewPanel({ session }: { session: Session }) {
  const t = useT();
  const sources = session.previewSources ?? [];
  return (
    <div style={{ padding: 10, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
      {sources.length === 0 ? (
        <div style={{ color: "var(--c-text-5)", fontSize: "var(--fs-secondary)", padding: 12 }}>{t("inspector.preview.empty")}</div>
      ) : sources.map((source) => <SourceCard key={[source.workspaceId, source.sessionId, source.terminalId, source.sourceUrl].join("\0")} source={source} />)}
    </div>
  );
}
