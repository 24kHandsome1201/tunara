import { useSyncExternalStore } from "react";
import { diagnosticReportText } from "./diagnostics-bridge";
import {
  clearSessionDiagnostics,
  diagnosticsCenter,
  diagnosticsForSession,
} from "./diagnostics-store";
import { useT } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { SessionRemediationNotice } from "@/ui/SessionRemediationNotice";
import { PanelActionButton, PanelEmptyState, PanelToolbar } from "@/ui/shared";

interface DiagnosticsCenterProps {
  sessionId: string;
  onClose: () => void;
  onCopyReport: (report: string) => void | Promise<void>;
}

/** Small standalone center; Flow F can place it without changing shared inspectors. */
export function DiagnosticsCenter({ sessionId, onClose, onCopyReport }: DiagnosticsCenterProps) {
  const t = useT();
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.id === sessionId));
  useSyncExternalStore(diagnosticsCenter.subscribe, diagnosticsCenter.snapshot);
  const events = diagnosticsForSession(sessionId);
  const close = () => { diagnosticsCenter.close(); onClose(); };

  return (
    <section aria-labelledby="diagnostics-panel-title" role="region" onKeyDown={(event) => { if (event.key === "Escape") close(); }} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <PanelToolbar titleId="diagnostics-panel-title" title={t("diagnostics.title")}>
        {events.length > 0 && (
          <>
            <PanelActionButton onClick={() => { void onCopyReport(diagnosticReportText(sessionId)); }}>
              {t("diagnostics.copy")}
            </PanelActionButton>
            <PanelActionButton onClick={() => clearSessionDiagnostics(sessionId)}>{t("diagnostics.clear")}</PanelActionButton>
          </>
        )}
        <PanelActionButton onClick={close} aria-label={t("diagnostics.close")}>{t("common.close")}</PanelActionButton>
      </PanelToolbar>
      {session && <div style={{ padding: "10px 10px 0" }}><SessionRemediationNotice session={session} /></div>}
      {events.length === 0 ? (
        <PanelEmptyState label={t("diagnostics.empty")} sublabel={t("diagnostics.empty_hint")} />
      ) : (
        <ol aria-live="polite" style={{ flex: 1, minHeight: 0, overflow: "auto", listStyle: "none", margin: 0, padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
          {events.map((event, index) => (
            <li key={`${event.requestId}-${event.diagnostic.timestamp}-${index}`} style={{ padding: 8, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", color: "var(--c-text-3)", fontSize: "var(--fs-meta)", overflowWrap: "anywhere" }}>
              <code>{event.diagnostic.stage}</code>{" "}
              <span>{event.status}</span>{" "}
              <code>{event.diagnostic.code}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
