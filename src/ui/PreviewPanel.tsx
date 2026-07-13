import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "./types";
import { useT } from "@/modules/i18n";
import { previewBlockReason, previewClose, previewFitViewport, previewGoBack, previewGoForward, previewNavigate, previewOpen, previewRefresh, previewResetViewport, previewResetZoom, previewSetViewport, previewSetZoom, previewStatus } from "@/modules/preview/preview-window";
import type { PreviewRuntimeState, PreviewRuntimeStatus } from "@/modules/preview/preview-window";
import type { PreviewSource } from "@/modules/preview/preview-source";

function SourceCard({ source }: { source: PreviewSource }) {
  const t = useT();
  const blocked = previewBlockReason(source);
  const [runtimeState, setRuntimeState] = useState<PreviewRuntimeState | null>(null);
  const [address, setAddress] = useState(source.sourceUrl);
  const addressEditingRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const statusRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let syncing = false;
    const sync = async () => {
      if (syncing) return;
      syncing = true;
      const sequence = ++statusRequestRef.current;
      try {
        const status = await previewStatus(source);
        if (!cancelled && sequence === statusRequestRef.current) {
          setRuntimeState(status);
          if (status && !addressEditingRef.current) setAddress(status.currentUrl);
        }
      } catch {
        // A transient status read must not replace an actionable open/refresh error.
      } finally {
        syncing = false;
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [source]);

  const run = async (action: () => Promise<unknown>, pendingStatus?: PreviewRuntimeStatus) => {
    setBusy(true);
    setError(undefined);
    statusRequestRef.current += 1;
    if (pendingStatus) setRuntimeState((current) => current ? { ...current, status: pendingStatus } : null);
    try {
      await action();
      const sequence = ++statusRequestRef.current;
      const status = await previewStatus(source);
      if (sequence === statusRequestRef.current) {
        setRuntimeState(status);
        if (status) setAddress(status.currentUrl);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try {
        const sequence = ++statusRequestRef.current;
        const status = await previewStatus(source);
        if (sequence === statusRequestRef.current) setRuntimeState(status);
      } catch {
        // Keep the last confirmed state when native status is also unavailable.
      }
    } finally {
      setBusy(false);
    }
  };

  const runtimeStatus = runtimeState?.status ?? null;
  const displayStatus = source.state === "stale" ? "stale" : runtimeStatus ?? "closed";
  const isOpen = runtimeState !== null;

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
        <span role="status" style={{ marginLeft: "auto", color: displayStatus === "failed" ? "var(--c-danger)" : blocked || displayStatus === "stale" ? "var(--c-warning)" : displayStatus === "ready" ? "var(--c-success)" : "var(--c-text-4)", fontSize: "var(--fs-meta)" }}>
          {t(`inspector.preview.status.${displayStatus}`)}
        </span>
      </div>
      {isOpen && <form aria-label={t("inspector.preview.address_form")} onSubmit={(event) => { event.preventDefault(); addressEditingRef.current = false; void run(() => previewNavigate(source, address), "loading"); }} style={{ display: "flex", gap: 6 }}>
        <button type="button" aria-label={t("inspector.preview.back")} disabled={busy || !!blocked || !runtimeState.canGoBack || runtimeStatus !== "ready"} onClick={() => void run(() => previewGoBack(source), "loading")}>←</button>
        <button type="button" aria-label={t("inspector.preview.forward")} disabled={busy || !!blocked || !runtimeState.canGoForward || runtimeStatus !== "ready"} onClick={() => void run(() => previewGoForward(source), "loading")}>→</button>
        <input aria-label={t("inspector.preview.address")} value={address} disabled={busy || !!blocked || runtimeStatus !== "ready"} onFocus={() => { addressEditingRef.current = true; }} onBlur={() => { addressEditingRef.current = false; }} onChange={(event) => setAddress(event.target.value)} style={{ minWidth: 0, flex: 1, fontFamily: "var(--font-mono)" }} />
        <button type="submit" disabled={busy || !!blocked || runtimeStatus !== "ready"}>{t("inspector.preview.go")}</button>
      </form>}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "var(--fs-meta)", color: "var(--c-text-3)", minWidth: 0 }}>
        {row(t("inspector.preview.repository"), source.repositoryId)}
        {row(t("inspector.preview.worktree"), source.worktreeId)}
        {row(t("inspector.preview.session"), source.sessionId)}
        {row(t("inspector.preview.terminal"), source.terminalId)}
        {row("URL", source.sourceUrl)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button disabled={busy || !!blocked} onClick={() => void run(() => previewOpen(source), "opening")}>{isOpen ? t("inspector.preview.focus") : t("inspector.preview.open")}</button>
        <button disabled={busy || !!blocked || !isOpen || runtimeStatus === "opening" || runtimeStatus === "loading"} onClick={() => void run(() => previewRefresh(source), "loading")}>{t("inspector.preview.refresh")}</button>
        <button disabled={busy || !isOpen} onClick={() => void run(() => previewClose(source))}>{t("inspector.preview.close")}</button>
        <button disabled={busy} onClick={() => void run(() => openUrl(source.sourceUrl))}>{t("inspector.preview.external")}</button>
      </div>
      {isOpen && <div aria-label={t("inspector.preview.zoom_controls")} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--fs-meta)" }}>
        <span style={{ color: "var(--c-text-5)" }}>{t("inspector.preview.zoom")}</span>
        {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((factor) => <button key={factor} disabled={busy || !!blocked || runtimeStatus !== "ready"} aria-pressed={Math.abs(runtimeState.zoomFactor - factor) < 0.001} onClick={() => void run(() => previewSetZoom(source, factor))}>{Math.round(factor * 100)}%</button>)}
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewResetZoom(source))}>{t("inspector.preview.reset")}</button>
      </div>}
      {isOpen && <div aria-label={t("inspector.preview.viewport_controls")} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--fs-meta)" }}>
        <span style={{ color: "var(--c-text-5)" }}>{t("inspector.preview.viewport")}</span>
        {[[390, 844, "Phone"], [768, 1024, "Tablet"], [1280, 720, "Desktop"]].map(([width, height, label]) => <button key={label} disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewSetViewport(source, Number(width), Number(height)))}>{label} {width}×{height}</button>)}
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewFitViewport(source))}>{t("inspector.preview.fit")}</button>
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewResetViewport(source))}>{t("inspector.preview.reset")}</button>
        <span role="status" style={{ color: runtimeState.viewport.exact ? "var(--c-text-4)" : "var(--c-warning)" }}>
          {runtimeState.viewport.actualWidth}×{runtimeState.viewport.actualHeight}{runtimeState.viewport.exact ? "" : ` · ${t("inspector.preview.viewport_unavailable")}`}
        </span>
      </div>}
      {displayStatus === "failed" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-danger)" }}>{t("inspector.preview.failed_help")}</div>}
      {displayStatus === "stale" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-warning)" }}>{t("inspector.preview.stale_help")}</div>}
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
