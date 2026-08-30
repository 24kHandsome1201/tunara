import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "./types";
import { useT } from "@/modules/i18n";
import { previewActionNonce, previewBlockReason, previewClose, previewDisplayUrl, previewGoBack, previewGoForward, previewNavigate, previewOpen, previewRefresh, previewRestartPrepare, previewStatus, previewTunnelClose, previewTunnelOpen, previewTunnelStatus } from "@/modules/preview/preview-window";
import type { PreviewRuntimeState, PreviewRuntimeStatus, PreviewTunnelState } from "@/modules/preview/preview-window";
import type { PreviewSource } from "@/modules/preview/preview-source";
import { PanelEmptyState } from "./shared";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { issueFocusReturnToken, returnTerminalFocus } from "@/modules/terminal/lib/binding-aware-async-action";

function SourceCard({ source, session }: { source: PreviewSource; session: Session }) {
  const t = useT();
  const isRemote = source.transport === "ssh";
  const [tunnelState, setTunnelState] = useState<PreviewTunnelState | null>(null);
  const effectiveSource = tunnelState?.previewSource ?? source;
  const blocked = previewBlockReason(effectiveSource);
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
        const tunnel = isRemote ? await previewTunnelStatus(source) : null;
        if (!cancelled && isRemote) setTunnelState(tunnel);
        const runtimeSource = tunnel?.previewSource ?? source;
        const status = tunnel?.status === "ready" || !isRemote ? await previewStatus(runtimeSource) : null;
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
    // 页面隐藏时暂停轮询（省电省请求），回到前台立即补一次同步
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void sync();
    }, 4000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isRemote, source]);

  const run = async (
    action: () => Promise<unknown>,
    pendingStatus?: PreviewRuntimeStatus,
    syncStatus = true,
  ) => {
    setBusy(true);
    setError(undefined);
    statusRequestRef.current += 1;
    if (pendingStatus) setRuntimeState((current) => current ? { ...current, status: pendingStatus } : null);
    try {
      await action();
      if (!syncStatus) return;
      const sequence = ++statusRequestRef.current;
      const status = await previewStatus(effectiveSource);
      if (sequence === statusRequestRef.current) {
        setRuntimeState(status);
        if (status) setAddress(status.currentUrl);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (!syncStatus) return;
      try {
        const sequence = ++statusRequestRef.current;
        const status = await previewStatus(effectiveSource);
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
  const currentProvenance = session.previewCommandProvenance;
  const sourceProvenance = source.restartProvenance;
  const provenanceMatches = !!currentProvenance && !!sourceProvenance
    && currentProvenance.generation === sourceProvenance.generation
    && currentProvenance.sequence === sourceProvenance.sequence
    && currentProvenance.command === sourceProvenance.command
    && currentProvenance.submittedAt === sourceProvenance.submittedAt;
  const restartUiReason = session.ptyId === undefined
    ? "pty-exited"
    : session.agent || session.runState === "running"
      ? "terminal-busy"
      : !provenanceMatches
        ? "provenance-changed"
        : runtimeState?.restart.reason ?? "command-unavailable";
  const restartUiEligible = !!runtimeState?.restart.eligible && restartUiReason === "ready";

  const establishTunnelAndOpen = async () => {
    const tunnel = await previewTunnelOpen(source, previewActionNonce());
    setTunnelState(tunnel);
    if (!tunnel.previewSource) throw new Error("SSH tunnel did not return a forwarded Preview source");
    await previewOpen(tunnel.previewSource);
    const status = await previewStatus(tunnel.previewSource);
    setRuntimeState(status);
    if (status) setAddress(status.currentUrl);
  };

  const closeTunnelAndPreview = async () => {
    await previewTunnelClose(source);
    setTunnelState(null);
    setRuntimeState(null);
  };

  const viewSourceTerminal = () => {
    useSessionsStore.getState().setActive(source.sessionId);
    useUIStore.getState().setPanelVisible(false);
    const token = issueFocusReturnToken(source.sessionId);
    window.setTimeout(() => {
      if (token) returnTerminalFocus(token);
    }, 0);
  };

  const row = (label: string, value: string) => (
    <div style={{ display: "grid", gridTemplateColumns: "68px minmax(0, 1fr)", gap: 6, minWidth: 0 }}>
      <span style={{ color: "var(--c-text-5)" }}>{label}</span>
      <span title={value} style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );

  return (
    <section className="preview-source-card" style={{ padding: 10, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 650, color: "var(--c-text-primary)" }}>{t(isRemote ? "inspector.preview.remote_source" : "inspector.preview.source")}</span>
        <span role="status" style={{ marginLeft: "auto", color: displayStatus === "failed" ? "var(--c-error)" : blocked || displayStatus === "stale" ? "var(--c-warning)" : displayStatus === "ready" ? "var(--c-success)" : "var(--c-text-4)", fontSize: "var(--fs-meta)" }}>
          {t(`inspector.preview.status.${displayStatus}`)}
        </span>
      </div>
      {isOpen && <form className="preview-toolbar" aria-label={t("inspector.preview.address_form")} onSubmit={(event) => { event.preventDefault(); addressEditingRef.current = false; void run(() => previewNavigate(effectiveSource, address), "loading"); }} style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
        <button className="preview-control" type="button" aria-label={t("inspector.preview.back")} disabled={busy || !!blocked || !runtimeState.canGoBack || runtimeStatus !== "ready"} onClick={() => void run(() => previewGoBack(effectiveSource), "loading")}>←</button>
        <button className="preview-control" type="button" aria-label={t("inspector.preview.forward")} disabled={busy || !!blocked || !runtimeState.canGoForward || runtimeStatus !== "ready"} onClick={() => void run(() => previewGoForward(effectiveSource), "loading")}>→</button>
        <input className="preview-control ui-native-control" aria-label={t("inspector.preview.address")} value={address} disabled={busy || !!blocked || runtimeStatus !== "ready"} onFocus={() => { addressEditingRef.current = true; }} onBlur={() => { addressEditingRef.current = false; }} onChange={(event) => setAddress(event.target.value)} style={{ minWidth: 0, flex: "1 1 180px", fontFamily: "var(--font-mono)" }} />
        <button className="preview-control" type="submit" disabled={busy || !!blocked || runtimeStatus !== "ready"}>{t("inspector.preview.go")}</button>
      </form>}
      {row(isRemote ? t("inspector.preview.remote_url") : t("inspector.preview.url"), previewDisplayUrl(source.sourceUrl))}
      {isRemote && row(t("inspector.preview.local_endpoint"), tunnelState?.localEndpoint ?? t("inspector.preview.local_endpoint_missing"))}
      {isRemote && row(t("inspector.preview.connection"), tunnelState ? t(`inspector.preview.tunnel.${tunnelState.status}`) : t("inspector.preview.tunnel.closed"))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button data-preview-action="view-source-terminal" disabled={busy} onClick={viewSourceTerminal}>{t("inspector.preview.view_terminal")}</button>
        {isRemote ? (
          <button className="preview-action-primary" data-preview-action="open-tunnel" disabled={busy || source.state !== "active" || source.workspaceResolution !== "resolved" || tunnelState?.status === "opening"} onClick={() => void run(establishTunnelAndOpen, "opening", false)}>{t("inspector.preview.tunnel.open")}</button>
        ) : <button className="preview-action-primary" disabled={busy || !!blocked} onClick={() => void run(() => previewOpen(effectiveSource), "opening")}>{isOpen ? t("inspector.preview.focus") : t("inspector.preview.open")}</button>}
        <button disabled={busy || !!blocked || !isOpen || runtimeStatus === "opening" || runtimeStatus === "loading"} onClick={() => void run(() => previewRefresh(effectiveSource), "loading")}>{t("inspector.preview.refresh")}</button>
        <button data-preview-action={isRemote ? "close-tunnel" : "close-preview"} disabled={busy || (!isOpen && !tunnelState)} onClick={() => void run(isRemote ? closeTunnelAndPreview : () => previewClose(effectiveSource), undefined, !isRemote)}>{isRemote ? t("inspector.preview.tunnel.close") : t("inspector.preview.close")}</button>
        <button disabled={busy || (isRemote && !tunnelState?.localEndpoint)} onClick={() => void run(() => openUrl(isRemote ? tunnelState?.localEndpoint ?? "" : source.sourceUrl))}>{t("inspector.preview.external")}</button>
      </div>
      {displayStatus === "failed" && runtimeState && <section aria-label={t("inspector.preview.restart.title")} style={{ borderTop: "1px solid var(--c-border-1)", paddingTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 650 }}>{t("inspector.preview.restart.title")}</span>
          <button data-preview-action="prepare-restart" disabled={busy || !restartUiEligible} title={t(`inspector.preview.restart.reason.${restartUiReason}`)} onClick={() => void run(() => previewRestartPrepare(effectiveSource))}>{t("inspector.preview.restart.prepare")}</button>
        </div>
        {runtimeState.restart.command && <code style={{ fontSize: "var(--fs-meta)", overflowWrap: "anywhere" }}>{runtimeState.restart.command}</code>}
        <div role="status" style={{ color: restartUiEligible ? "var(--c-text-4)" : "var(--c-warning)", fontSize: "var(--fs-meta)" }}>
          {t(`inspector.preview.restart.reason.${restartUiReason}`)}
        </div>
      </section>}
      {displayStatus === "failed" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-error)" }}>{t("inspector.preview.failed_help")}</div>}
      {isRemote && tunnelState?.status === "failed" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-error)" }}>{tunnelState.reason ?? t("inspector.preview.tunnel.failed")}</div>}
      {displayStatus === "stale" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-warning)" }}>{t("inspector.preview.stale_help")}</div>}
      {error && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-error)" }}>{error}</div>}
    </section>
  );
}

export function PreviewPanel({ session }: { session: Session }) {
  const t = useT();
  const sources = session.previewSources ?? [];
  return (
    <div style={{ padding: 10, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
      {sources.length === 0 ? (
        <PanelEmptyState label={t("inspector.preview.empty")} />
      ) : sources.map((source) => <SourceCard key={[source.workspaceId, source.sessionId, source.terminalId, source.sourceUrl].join("\0")} source={source} session={session} />)}
    </div>
  );
}
