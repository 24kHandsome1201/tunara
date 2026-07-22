import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Session } from "./types";
import { useT } from "@/modules/i18n";
import { previewActionNonce, previewBlockReason, previewCapture, previewClose, previewDisplayUrl, previewFitViewport, previewGoBack, previewGoForward, previewNavigate, previewOpen, previewRefresh, previewResetViewport, previewResetZoom, previewRestartPrepare, previewSendCaptureToSourceTerminal, previewSetViewport, previewSetZoom, previewStatus, previewTelemetryClear, previewTelemetrySend, previewTunnelClose, previewTunnelOpen, previewTunnelStatus } from "@/modules/preview/preview-window";
import type { PreviewCaptureResult, PreviewRuntimeState, PreviewRuntimeStatus, PreviewTunnelState } from "@/modules/preview/preview-window";
import type { PreviewSource } from "@/modules/preview/preview-source";
import { copyText } from "./lib/clipboard";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

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
  const [capture, setCapture] = useState<PreviewCaptureResult>();
  const [captureNotice, setCaptureNotice] = useState<string>();
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
    const timer = window.setInterval(() => void sync(), 750);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isRemote, source]);

  const run = async (action: () => Promise<unknown>, pendingStatus?: PreviewRuntimeStatus, syncStatus = true) => {
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
  const telemetry = runtimeState?.telemetry;
  const hasTelemetry = !!telemetry?.events.length;
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
  const remotePort = tunnelState?.remotePort ?? (() => {
    try {
      const url = new URL(source.sourceUrl);
      return Number(url.port || (url.protocol === "https:" ? 443 : 80));
    } catch {
      return 0;
    }
  })();

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
    window.setTimeout(() => {
      const pane = [...document.querySelectorAll<HTMLElement>("[data-terminal-session-id]")]
        .find((element) => element.dataset.terminalSessionId === source.sessionId);
      pane?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
    }, 0);
  };

  const capturePreview = async () => {
    setBusy(true);
    setError(undefined);
    setCaptureNotice(undefined);
    try {
      const result = await previewCapture(effectiveSource);
      setCapture(result);
      setCaptureNotice(t("inspector.preview.capture_saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const copyCapture = async () => {
    if (!capture) return;
    const copied = await copyText(capture.preparedText);
    setCaptureNotice(copied ? t("inspector.preview.capture_copied") : t("inspector.preview.capture_copy_failed"));
  };

  const sendCapture = async () => {
    if (!capture) return;
    setBusy(true);
    setError(undefined);
    setCaptureNotice(undefined);
    try {
      const receipt = await previewSendCaptureToSourceTerminal(effectiveSource, capture.captureId);
      setCaptureNotice(t("inspector.preview.capture_sent", { bytes: receipt.bytesWritten }));
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
        <span style={{ fontWeight: 650, color: "var(--c-text-primary)" }}>{t(isRemote ? "inspector.preview.remote_source" : "inspector.preview.source")}</span>
        <span role="status" style={{ marginLeft: "auto", color: displayStatus === "failed" ? "var(--c-danger)" : blocked || displayStatus === "stale" ? "var(--c-warning)" : displayStatus === "ready" ? "var(--c-success)" : "var(--c-text-4)", fontSize: "var(--fs-meta)" }}>
          {t(`inspector.preview.status.${displayStatus}`)}
        </span>
      </div>
      {isOpen && <form aria-label={t("inspector.preview.address_form")} onSubmit={(event) => { event.preventDefault(); addressEditingRef.current = false; void run(() => previewNavigate(effectiveSource, address), "loading"); }} style={{ display: "flex", gap: 6 }}>
        <button type="button" aria-label={t("inspector.preview.back")} disabled={busy || !!blocked || !runtimeState.canGoBack || runtimeStatus !== "ready"} onClick={() => void run(() => previewGoBack(effectiveSource), "loading")}>←</button>
        <button type="button" aria-label={t("inspector.preview.forward")} disabled={busy || !!blocked || !runtimeState.canGoForward || runtimeStatus !== "ready"} onClick={() => void run(() => previewGoForward(effectiveSource), "loading")}>→</button>
        <input aria-label={t("inspector.preview.address")} value={address} disabled={busy || !!blocked || runtimeStatus !== "ready"} onFocus={() => { addressEditingRef.current = true; }} onBlur={() => { addressEditingRef.current = false; }} onChange={(event) => setAddress(event.target.value)} style={{ minWidth: 0, flex: 1, fontFamily: "var(--font-mono)" }} />
        <button type="submit" disabled={busy || !!blocked || runtimeStatus !== "ready"}>{t("inspector.preview.go")}</button>
      </form>}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: "var(--fs-meta)", color: "var(--c-text-3)", minWidth: 0 }}>
        {row(t("inspector.preview.repository"), source.repositoryId)}
        {row(t("inspector.preview.worktree"), source.worktreeId)}
        {row(t("inspector.preview.workspace"), source.workspaceId)}
        {row(t("inspector.preview.session"), source.sessionId)}
        {row(t("inspector.preview.terminal"), source.terminalId)}
        {row(t("inspector.preview.generation"), source.restartProvenance?.generation ?? t("inspector.preview.generation_missing"))}
        {row(t("inspector.preview.physical_pty"), source.physicalPtyId === undefined ? t("inspector.preview.physical_pty_missing") : String(source.physicalPtyId))}
        {isRemote && row(t("inspector.preview.ssh_host"), `${source.sshUser ?? "?"}@${source.sshHost ?? "?"}:${source.sshPort ?? "?"}`)}
        {row(isRemote ? t("inspector.preview.remote_url") : "URL", previewDisplayUrl(source.sourceUrl))}
        {isRemote && row(t("inspector.preview.remote_port"), String(remotePort))}
        {isRemote && row(t("inspector.preview.local_endpoint"), tunnelState?.localEndpoint ?? t("inspector.preview.local_endpoint_missing"))}
        {isRemote && row(t("inspector.preview.connection"), tunnelState ? t(`inspector.preview.tunnel.${tunnelState.status}`) : t("inspector.preview.tunnel.closed"))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button data-preview-action="view-source-terminal" disabled={busy} onClick={viewSourceTerminal}>{t("inspector.preview.view_terminal")}</button>
        {isRemote ? (
          <button data-preview-action="open-tunnel" disabled={busy || source.state !== "active" || source.workspaceResolution !== "resolved" || tunnelState?.status === "opening"} onClick={() => void run(establishTunnelAndOpen, "opening", false)}>{t("inspector.preview.tunnel.open")}</button>
        ) : <button disabled={busy || !!blocked} onClick={() => void run(() => previewOpen(effectiveSource), "opening")}>{isOpen ? t("inspector.preview.focus") : t("inspector.preview.open")}</button>}
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
      {isOpen && <div aria-label={t("inspector.preview.zoom_controls")} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--fs-meta)" }}>
        <span style={{ color: "var(--c-text-5)" }}>{t("inspector.preview.zoom")}</span>
        {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((factor) => <button key={factor} disabled={busy || !!blocked || runtimeStatus !== "ready"} aria-pressed={Math.abs(runtimeState.zoomFactor - factor) < 0.001} onClick={() => void run(() => previewSetZoom(effectiveSource, factor))}>{Math.round(factor * 100)}%</button>)}
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewResetZoom(effectiveSource))}>{t("inspector.preview.reset")}</button>
      </div>}
      {isOpen && <div aria-label={t("inspector.preview.viewport_controls")} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--fs-meta)" }}>
        <span style={{ color: "var(--c-text-5)" }}>{t("inspector.preview.viewport")}</span>
        {[[390, 844, "phone"], [768, 1024, "tablet"], [1280, 720, "desktop"]].map(([width, height, key]) => <button key={key} disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewSetViewport(effectiveSource, Number(width), Number(height)))}>{t(`inspector.preview.viewport.${key}`)} {width}×{height}</button>)}
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewFitViewport(effectiveSource))}>{t("inspector.preview.fit")}</button>
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void run(() => previewResetViewport(effectiveSource))}>{t("inspector.preview.reset")}</button>
        <span role="status" style={{ color: runtimeState.viewport.exact ? "var(--c-text-4)" : "var(--c-warning)" }}>
          {runtimeState.viewport.actualWidth}×{runtimeState.viewport.actualHeight}{runtimeState.viewport.exact ? "" : ` · ${t("inspector.preview.viewport_unavailable")}`}
        </span>
      </div>}
      {isOpen && <div aria-label={t("inspector.preview.capture_controls")} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: "var(--fs-meta)" }}>
        <span style={{ color: "var(--c-text-5)" }}>{t("inspector.preview.capture")}</span>
        <button disabled={busy || !!blocked || runtimeStatus !== "ready"} onClick={() => void capturePreview()}>{t("inspector.preview.capture_now")}</button>
        <button disabled={busy || !capture} onClick={() => void copyCapture()}>{t("inspector.preview.capture_copy")}</button>
        <button data-preview-action="send-capture" disabled={busy || !!blocked || !capture || effectiveSource.physicalPtyId === undefined || runtimeStatus !== "ready"} onClick={() => void sendCapture()}>{t("inspector.preview.capture_send")}</button>
        {capture && <span title={capture.localRef} style={{ fontFamily: "var(--font-mono)", color: "var(--c-text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
          {capture.viewportCssWidth}×{capture.viewportCssHeight} CSS · {capture.imageWidth}×{capture.imageHeight} PNG · {capture.localRef}
        </span>}
      </div>}
      {captureNotice && <div role="status" style={{ fontSize: "var(--fs-meta)", color: "var(--c-success)" }}>{captureNotice}</div>}
      {isOpen && <section aria-label={t("inspector.preview.telemetry")} style={{ borderTop: "1px solid var(--c-border-1)", paddingTop: 7, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 650 }}>{t("inspector.preview.telemetry")}</span>
          <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{telemetry?.events.length ?? 0}/{32}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <button disabled={busy || !hasTelemetry} onClick={() => { if (telemetry) void copyText(telemetry.text); }}>{t("inspector.preview.telemetry.copy")}</button>
            <button data-preview-action="send-telemetry" disabled={busy || !!blocked || !hasTelemetry || effectiveSource.physicalPtyId === undefined} onClick={() => void run(() => previewTelemetrySend(effectiveSource))}>{t("inspector.preview.telemetry.send")}</button>
            <button disabled={busy || !hasTelemetry} onClick={() => void run(() => previewTelemetryClear(effectiveSource))}>{t("inspector.preview.telemetry.clear")}</button>
          </div>
        </div>
        {!hasTelemetry ? <div style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("inspector.preview.telemetry.empty")}</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {telemetry?.events.map((event, index) => <div key={`${event.kind}\0${event.message}\0${index}`} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", overflowWrap: "anywhere" }}>
              <span style={{ color: event.kind === "network-failure" ? "var(--c-warning)" : "var(--c-danger)" }}>[{event.kind}]</span> {event.message}{event.count > 1 ? ` ×${event.count}` : ""}
            </div>)}
            {!!telemetry?.dropped && <div style={{ color: "var(--c-warning)", fontSize: "var(--fs-meta)" }}>{t("inspector.preview.telemetry.dropped")} {telemetry.dropped}</div>}
          </div>
        )}
      </section>}
      {displayStatus === "failed" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-danger)" }}>{t("inspector.preview.failed_help")}</div>}
      {isRemote && tunnelState?.status === "failed" && <div role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-danger)" }}>{tunnelState.reason ?? t("inspector.preview.tunnel.failed")}</div>}
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
      ) : sources.map((source) => <SourceCard key={[source.workspaceId, source.sessionId, source.terminalId, source.sourceUrl].join("\0")} source={source} session={session} />)}
    </div>
  );
}
