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
    <section aria-label={t("diagnostics.title")} role="dialog" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <header>
        <h2>{t("diagnostics.title")}</h2>
        <button type="button" onClick={close} aria-label={t("diagnostics.close")}>{t("common.close")}</button>
      </header>
      {session && <SessionRemediationNotice session={session} />}
      <ol aria-live="polite">
        {events.map((event, index) => (
          <li key={`${event.requestId}-${event.diagnostic.timestamp}-${index}`}>
            <code>{event.diagnostic.stage}</code>{" "}
            <span>{event.status}</span>{" "}
            <code>{event.diagnostic.code}</code>
          </li>
        ))}
      </ol>
      {events.length === 0 && <p>{t("diagnostics.empty")}</p>}
      <footer>
        <button type="button" onClick={() => { void onCopyReport(diagnosticReportText(sessionId)); }}>
          {t("diagnostics.copy")}
        </button>
        <button type="button" onClick={() => clearSessionDiagnostics(sessionId)}>{t("diagnostics.clear")}</button>
      </footer>
    </section>
  );
}
