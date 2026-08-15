import { remediationForSession, remediationIsCurrent } from "@/modules/terminal/lib/connection-state";
import { useT } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { reconnectPrefillFromSession, type Session } from "./types";
import { AccentActionButton } from "./lib/ui-primitives";

/** Generation-scoped user action for an SSH state that cannot self-heal. */
export function SessionRemediationNotice({ session, compact = false }: { session: Session; compact?: boolean }) {
  const t = useT();
  const remediation = remediationForSession(session);
  if (!remediation) return null;

  const run = () => {
    const latest = useSessionsStore.getState().sessions.find((candidate) => candidate.id === remediation.sessionId);
    if (!latest || !remediationIsCurrent(latest, remediation)) {
      useUIStore.getState().addToast({
        sessionId: remediation.sessionId,
        title: t("remediation.stale"),
        subtitle: t("remediation.stale_detail"),
        variant: "warning",
      });
      return;
    }
    const prefill = reconnectPrefillFromSession(latest);
    if (prefill) useUIStore.getState().openSshConnect(prefill);
  };

  const binding = remediation.source === "binding"
    ? `${remediation.binding.physicalPtyId} · ${remediation.binding.transportGeneration}`
    : `${t("remediation.source.pending_generation")} · ${remediation.lifecycle}`;
  return (
    <div
      role={compact ? undefined : "alert"}
      data-remediation-kind={remediation.kind}
      style={{
        display: "flex",
        flexDirection: compact ? "row" : "column",
        alignItems: compact ? "center" : "stretch",
        gap: compact ? 8 : 6,
        minWidth: 0,
        padding: compact ? 0 : 9,
        border: compact ? undefined : "1px solid var(--c-warning)",
        borderRadius: compact ? undefined : "var(--r-card)",
        color: "var(--c-text-2)",
        fontSize: "var(--fs-meta)",
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <strong>{t(`remediation.${remediation.kind}.title`)}</strong>
        <div style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {compact
            ? remediation.endpoint
            : `${remediation.endpoint} · ${t("remediation.source.session", { session: remediation.sessionId })} · ${t("remediation.source.binding", { binding })}`}
        </div>
        {!compact && <div>{t("remediation.replacement_shell")}</div>}
      </div>
      <AccentActionButton onClick={run}>
        {t(`remediation.${remediation.kind}.action`)}
      </AccentActionButton>
    </div>
  );
}
